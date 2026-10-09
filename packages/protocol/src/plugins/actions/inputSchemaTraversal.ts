import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';

/**
 * Expands one declared schema position into the exact alternatives an input
 * value can take there. A union contributes every arm, so a path proven across
 * the expansion is proven for every representable input. A schema that already
 * declares its own `type` or `properties` is its own single alternative, which
 * keeps a nullable credential-ref leaf intact rather than splitting it.
 */
export function expandDeclaredInputAlternatives(
  schema: PluginJsonSchemaV2,
): readonly PluginJsonSchemaV2[] {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (
    !alternatives
    || alternatives.length === 0
    || schema.type !== undefined
    || schema.properties !== undefined
  ) return [schema];
  return alternatives.flatMap(expandDeclaredInputAlternatives);
}

/**
 * Resolves one declared input path. By default every representable input arm
 * must carry the path. Conditional ordinary hints may instead resolve only
 * the branches declaring it; no declaration anywhere still returns `null`.
 */
export function resolveDeclaredInputLeaves(
  inputSchema: PluginJsonSchemaV2,
  path: string,
  policy: 'every-arm' | 'conditional-field' = 'every-arm',
): readonly PluginJsonSchemaV2[] | null {
  let frontier: readonly PluginJsonSchemaV2[] = [inputSchema];
  for (const segment of path.split('.')) {
    const next: PluginJsonSchemaV2[] = [];
    for (const position of frontier) {
      for (const arm of expandDeclaredInputAlternatives(position)) {
        const property = arm.type === 'object' ? arm.properties?.[segment] : undefined;
        if (!property) {
          if (policy === 'conditional-field') continue;
          return null;
        }
        next.push(property);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return frontier.length > 0 ? frontier : null;
}
