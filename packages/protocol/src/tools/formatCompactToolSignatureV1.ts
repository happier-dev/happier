const genericInput = 'Record<string, unknown>';

function asSchema(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

function formatName(name: string): string {
  return /^[A-Z_$][\w$]*$/i.test(name) ? name : JSON.stringify(name);
}

function resolveReference(root: unknown, reference: unknown): unknown {
  if (reference === '#') return root;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined;
  let pointer: string;
  try { pointer = decodeURIComponent(reference.slice(2)); } catch { return undefined; }
  let current = root;
  for (const part of pointer.split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function formatLiteral(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  return undefined;
}

/** Formats the input shape for discovery. The original JSON Schema validates the call. */
export function formatCompactToolSignatureV1(toolName: string, inputSchema: unknown): string {
  const active = new Set<object>();
  function formatUnion(parts: readonly unknown[], format: (part: unknown) => string | undefined): string | undefined {
    const values = parts.map(format);
    return values.includes(undefined) ? undefined : [...new Set(values)].join(' | ') || 'never';
  }
  function formatObject(schema: Readonly<Record<string, unknown>>): string | undefined {
    const properties = asSchema(schema.properties);
    if (schema.properties !== undefined && !properties) return undefined;
    const entries = Object.entries(properties ?? {});
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    if ([...required].some(name => typeof name !== 'string' || !Object.hasOwn(properties ?? {}, name))) return undefined;
    const additional = schema.additionalProperties;
    if (asSchema(additional)) {
      if (entries.length) return undefined;
      const value = formatSchema(additional);
      return value === undefined ? undefined : `Record<string, ${value}>`;
    }
    if (!entries.length) return additional === false ? 'Record<string, never>' : genericInput;

    const fields: string[] = [];
    for (const [name, property] of entries) {
      const type = formatSchema(property);
      if (type === undefined) return undefined;
      fields.push(`${formatName(name)}${required.has(name) ? '' : '?'}: ${type}`);
    }
    if (additional === true) fields.push('[key: string]: unknown');
    return `{ ${fields.join('; ')} }`;
  }
  function formatSchema(value: unknown): string | undefined {
    if (value === true || value === false) return value ? 'unknown' : 'never';
    const schema = asSchema(value);
    if (!schema || active.has(schema)) return undefined;
    active.add(schema);
    try {
      if (schema.$ref !== undefined) return formatSchema(resolveReference(inputSchema, schema.$ref));
      if (['allOf', 'not', 'if', 'patternProperties', 'dependencies', 'dependentSchemas', 'prefixItems']
        .some(keyword => Object.hasOwn(schema, keyword))) return undefined;
      if (Array.isArray(schema.oneOf)) return formatUnion(schema.oneOf, formatSchema);
      if (Array.isArray(schema.anyOf)) return formatUnion(schema.anyOf, formatSchema);
      if (Array.isArray(schema.enum)) return formatUnion(schema.enum, formatLiteral);
      if (Object.hasOwn(schema, 'const')) return formatLiteral(schema.const);
      if (Array.isArray(schema.type)) return formatUnion(schema.type, type => formatSchema({ ...schema, type }));
      switch (schema.type) {
        case 'object': return formatObject(schema);
        case 'array': {
          const item = schema.items === undefined ? 'unknown' : formatSchema(schema.items);
          return item === undefined ? undefined : `Array<${item}>`;
        }
        case 'integer': return 'number';
        case 'number': case 'string': case 'boolean': case 'null': return schema.type;
        case undefined: return schema.properties === undefined ? 'unknown' : formatObject(schema);
        default: return undefined;
      }
    } finally {
      active.delete(schema);
    }
  }

  return `${formatName(toolName)}(args: ${formatSchema(inputSchema) ?? genericInput}): Promise<unknown>`;
}
