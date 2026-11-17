import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';

/**
 * Proves only a layout change: bare document-local references name the same
 * constraints as their inline copies. Comparing pairs of schema nodes avoids
 * expansion and permits recursive constraints, while reference-only cycles and
 * reference siblings retain the owner's existing conservative proof.
 */
export function areCollectionSchemaLayoutsEquivalent(source: PluginJsonSchemaV2, target: PluginJsonSchemaV2): boolean {
  const dereference = (root: PluginJsonSchemaV2, initial: PluginJsonSchemaV2): PluginJsonSchemaV2 | null => {
    let schema = initial;
    const visited = new Set<PluginJsonSchemaV2>();
    while (schema.$ref !== undefined) {
      const pointer = schema.$ref;
      if (visited.has(schema) || Object.keys(schema).length !== 1
        || !(pointer === '#' || pointer.startsWith('#/')) || pointer.includes('%')) return null;
      visited.add(schema);
      let resolved: unknown = root;
      for (const segment of pointer === '#' ? [] : pointer.slice(2).split('/')) {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        resolved = resolved !== null && typeof resolved === 'object' && Object.hasOwn(resolved, key)
          ? (resolved as Readonly<Record<string, unknown>>)[key] : undefined;
      }
      if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) return null;
      schema = resolved as PluginJsonSchemaV2;
    }
    return schema;
  };
  const describe = (schema: PluginJsonSchemaV2) => {
    const { definitions: _definitions, $defs: _defs, ...constraints } = schema;
    const identity: Record<string, unknown> = { ...constraints };
    const children: PluginJsonSchemaV2[] = [];
    const childSlot = (child: PluginJsonSchemaV2) => { children.push(child); return null; };
    if (schema.properties) identity.properties = Object.fromEntries(Object.entries(schema.properties)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, child]) => [name, childSlot(child)]));
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (schema[key]) identity[key] = schema[key].map(childSlot);
    }
    if (Array.isArray(schema.items)) identity.items = schema.items.map(childSlot);
    for (const key of ['items', 'additionalItems', 'not', 'propertyNames', 'additionalProperties'] as const) {
      const child = schema[key];
      if (child !== undefined && typeof child === 'object' && !Array.isArray(child)) identity[key] = childSlot(child);
    }
    return { identity: createCanonicalJsonSigningInput(identity), children };
  };
  const compared = new WeakMap<PluginJsonSchemaV2, WeakSet<PluginJsonSchemaV2>>();
  const pending: [PluginJsonSchemaV2, PluginJsonSchemaV2][] = [[source, target]];
  while (pending.length > 0) {
    const [before, after] = pending.pop()!;
    const left = dereference(source, before), right = dereference(target, after);
    if (left === null || right === null) return false;
    if (compared.get(left)?.has(right)) continue;
    const a = describe(left), b = describe(right);
    if (a.identity !== b.identity) return false;
    const partners = compared.get(left) ?? new WeakSet<PluginJsonSchemaV2>();
    partners.add(right);
    compared.set(left, partners);
    for (let index = 0; index < a.children.length; index++) pending.push([a.children[index]!, b.children[index]!]);
  }
  return true;
}
