import type { ActionSpec } from './actionSpecs.js';
import { ActionInputPathSchema, type ActionInputFieldHint, type ActionInputHints } from './actionInputHints.js';
import { zodSchemaToJsonSchemaObject, type JsonSchemaObject } from './actionInputJsonSchema.js';

function isSchema(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAlternatives(schema: JsonSchemaObject): readonly JsonSchemaObject[] {
  if (isSchema(schema.properties)) return [schema];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(alternatives)) return [schema];
  return alternatives.flatMap(arm => isSchema(arm) ? objectAlternatives(arm) : []);
}

function fieldTitle(path: string): string {
  const words = path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fieldPresentation(schema: JsonSchemaObject): Pick<ActionInputFieldHint, 'widget' | 'options' | 'listSeparator'> {
  // The full input parser still owns constraints, branches and opaque values.
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf || Array.isArray(schema.type)) return { widget: 'json' };
  const choices = Array.isArray(schema.enum) && schema.enum.length > 0
    && schema.enum.every(value => typeof value === 'string' && value.length > 0) ? schema.enum : undefined;
  if (choices) return { widget: 'select', options: choices.map(value => ({ value, label: value })) };
  if (schema.enum) return { widget: 'json' };
  switch (schema.type) {
    case 'string': return { widget: schema.format === 'uri' || schema.format === 'url' ? 'url' : 'text' };
    case 'boolean': return { widget: 'boolean' };
    case 'number': return { widget: 'number' };
    case 'integer': return { widget: 'integer' };
    case 'array': {
      if (!isSchema(schema.items) || schema.items.type !== 'string') return { widget: 'json' };
      const item = fieldPresentation(schema.items);
      return item.widget === 'select' ? { widget: 'multiselect', options: item.options }
        : item.widget === 'text' || item.widget === 'url' ? { widget: 'text_list', listSeparator: 'newline' } : { widget: 'json' };
    }
    default: return { widget: 'json' };
  }
}

/** Presentation only: authored semantics win; the unchanged schema admits complete inputs. */
export function deriveActionInputHints(
  schema: JsonSchemaObject | undefined,
  authored: ActionInputHints | undefined,
): ActionInputHints | undefined {
  if (!schema) return authored;
  const authoredFields = authored?.fields ?? [];
  const fields = [...authoredFields];
  const appendFields = (position: JsonSchemaObject, prefix: string, parentRequired: boolean): void => {
    const alternatives = objectAlternatives(position);
    const properties = new Map<string, JsonSchemaObject[]>();
    for (const alternative of alternatives) {
      if (!isSchema(alternative.properties)) continue;
      for (const [key, property] of Object.entries(alternative.properties)) {
        if (!isSchema(property)) continue;
        const variants = properties.get(key) ?? [];
        variants.push(property);
        properties.set(key, variants);
      }
    }
    for (const [key, variants] of properties) {
      const path = prefix ? `${prefix}.${key}` : key;
      // A literal dotted key is not a nested path in the shared input grammar.
      if (key.includes('.') || !ActionInputPathSchema.safeParse(path).success
        || authoredFields.some(field => field.path === path)) continue;
      const required = parentRequired && alternatives.every(alternative => Array.isArray(alternative.required) && alternative.required.includes(key));
      if (authoredFields.some(field => field.path.startsWith(`${path}.`))) {
        // Retain the author's nested editor and fill its uncovered siblings,
        // without introducing an overlapping whole-object control.
        appendFields(variants.length === 1 ? variants[0]! : { anyOf: variants }, path, required);
        continue;
      }
      const property = variants[0]!;
      fields.push({
        path,
        title: typeof property.title === 'string' && property.title.trim() ? property.title : fieldTitle(key),
        ...(typeof property.description === 'string' && property.description.trim() ? { description: property.description } : {}),
        ...(alternatives.length > 1 ? { widget: 'json' as const } : fieldPresentation(property)),
        ...(required ? { required: true } : {}),
      });
    }
  };
  appendFields(schema, '', true);
  return fields.length === authoredFields.length ? authored : { ...authored, fields };
}

function withDerivedHints<T extends Readonly<{ inputSchema: ActionSpec['inputSchema']; inputHints?: ActionInputHints }>>(spec: T): T {
  const projected = { ...spec };
  Object.defineProperty(projected, 'inputHints', {
    configurable: true,
    enumerable: true,
    get() {
      // Prepare once on demand for this immutable catalog row, never eagerly
      // project the complete Action schema graph during Protocol module load.
      const value = deriveActionInputHints(zodSchemaToJsonSchemaObject(spec.inputSchema, { unrepresentable: 'any' }), spec.inputHints);
      Object.defineProperty(projected, 'inputHints', { value, enumerable: true });
      return value;
    },
  });
  return projected;
}

/** Complete the canonical and distinct caller-shape facets at their single owner. */
export function completeActionInputHints(spec: ActionSpec): ActionSpec {
  const api = spec.surfaceBindings?.api;
  return withDerivedHints({
    ...spec,
    ...(spec.cli ? { cli: withDerivedHints({ ...spec.cli,
      inputSchema: spec.cli.inputSchema ?? spec.inputSchema,
      inputHints: spec.cli.inputHints ?? spec.inputHints,
    }) } : {}),
    ...(api ? { surfaceBindings: { ...spec.surfaceBindings,
      api: withDerivedHints({ ...api, inputHints: api.inputHints ?? spec.inputHints }),
    } } : {}),
  });
}
