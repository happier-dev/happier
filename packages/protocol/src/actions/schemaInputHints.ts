import { sameStrictJsonValue, StrictJsonValueSchema } from '../json/strictJsonValue.js';
import type { ActionSpec } from './actionSpecs.js';
import { ActionInputPathSchema, type ActionInputFieldHint, type ActionInputHints } from './actionInputHints.js';
import { isUrlJsonSchemaFormat, zodSchemaToJsonSchemaObject, type JsonSchemaObject } from './actionInputJsonSchema.js';
import { readActionSchemaTopLevelFieldNames } from './actionCliProjection.js';

function isSchema(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAlternatives(schema: JsonSchemaObject): readonly JsonSchemaObject[] {
  if (isSchema(schema.properties)) return [schema];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(alternatives)) return [schema];
  return alternatives.flatMap(arm => isSchema(arm) ? objectAlternatives(arm) : []);
}

/** An undeclared key reads in sentence case ("expiresAt" → "Expires at"); a declared schema title always wins. */
function fieldTitle(path: string): string {
  const words = path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fieldPresentation(schema: JsonSchemaObject): Pick<ActionInputFieldHint, 'widget' | 'options' | 'listSeparator'> {
  // Composable literal unions declare the same choices as a string enum.
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!schema.$ref && !schema.allOf && Array.isArray(alternatives) && alternatives.length > 0
    && alternatives.every(arm => isSchema(arm) && typeof arm.const === 'string' && arm.const.length > 0)) {
    return { widget: 'select', options: alternatives.map(arm => ({ value: arm.const as string, label: arm.const as string })) };
  }
  // The full input parser still owns constraints, branches and opaque values.
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf || Array.isArray(schema.type)) return { widget: 'json' };
  const choices = Array.isArray(schema.enum) && schema.enum.length > 0
    && schema.enum.every(value => typeof value === 'string' && value.length > 0) ? schema.enum : undefined;
  if (choices) return { widget: 'select', options: choices.map(value => ({ value, label: value })) };
  if (schema.enum) return { widget: 'json' };
  switch (schema.type) {
    case 'string': return { widget: isUrlJsonSchemaFormat(schema.format) ? 'url' : 'text' };
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
  hideFixedFields = true,
): ActionInputHints | undefined {
  if (!schema) return authored;
  const authoredFields = authored?.fields ?? [];
  const fields = [...authoredFields];
  let changed = false;
  const appendFields = (position: JsonSchemaObject, prefix: string, parentRequired: boolean): void => {
    // Authored fields that name one union arm's properties choose that arm: the form is that shape, with its own
    // widgets, and the other arms stay for callers that pass complete inputs.
    const authoredHere = new Set(authoredFields.filter(field => !prefix || field.path.startsWith(`${prefix}.`))
      .map(field => (prefix ? field.path.slice(prefix.length + 1) : field.path).split('.')[0]!));
    const allAlternatives = objectAlternatives(position);
    const chosen = authoredHere.size === 0 ? [] : allAlternatives.filter(arm => isSchema(arm.properties)
      && [...authoredHere].every(key => Object.prototype.hasOwnProperty.call(arm.properties, key)));
    const alternatives = chosen.length > 0 ? chosen : allAlternatives;
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
      if (key.includes('.') || !ActionInputPathSchema.safeParse(path).success) continue;
      const property = variants[0]!;
      const required = parentRequired && alternatives.every(alternative => Array.isArray(alternative.required) && alternative.required.includes(key));
      const authoredIndex = fields.findIndex(field => field.path === path);
      if (hideFixedFields && Object.hasOwn(property, 'const') && variants.length === alternatives.length
        && variants.every(variant => sameStrictJsonValue(property.const, variant.const))) {
        const fixed = StrictJsonValueSchema.safeParse(property.const);
        if (fixed.success) {
          const truthy = { op: 'truthy', path } as const;
          const field: ActionInputFieldHint = {
            ...fields[authoredIndex],
            path,
            title: fields[authoredIndex]?.title ?? fieldTitle(key),
            widget: fields[authoredIndex]?.widget ?? fieldPresentation(property).widget,
            defaultValue: required ? fixed.data : undefined,
            // Keep the schema's fixed value available to draft seeding and out of every form state.
            visibleWhen: { op: 'and', all: [truthy, { op: 'not', predicate: truthy }] },
          };
          if (authoredIndex === -1) fields.push(field);
          else fields[authoredIndex] = field;
          changed = true;
          continue;
        }
      }
      if (authoredIndex !== -1) continue;
      if (authoredFields.some(field => field.path.startsWith(`${path}.`))) {
        // Retain the author's nested editor and fill its uncovered siblings,
        // without introducing an overlapping whole-object control.
        appendFields(variants.length === 1 ? variants[0]! : { anyOf: variants }, path, required);
        continue;
      }
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
  return changed || fields.length !== authoredFields.length ? { ...authored, fields } : authored;
}

function withDerivedHints<T extends Readonly<{ inputSchema: ActionSpec['inputSchema']; inputHints?: ActionInputHints }>>(
  spec: T,
  readAuthoredHints = () => spec.inputHints,
  hideFixedFields = true,
): T {
  const projected = { ...spec };
  Object.defineProperty(projected, 'inputHints', {
    configurable: true,
    enumerable: true,
    get() {
      // Prepare once on demand for this immutable catalog row, never eagerly
      // project the complete Action schema graph during Protocol module load.
      const value = deriveActionInputHints(
        zodSchemaToJsonSchemaObject(spec.inputSchema, { unrepresentable: 'any' }), readAuthoredHints(), hideFixedFields,
      );
      Object.defineProperty(projected, 'inputHints', { value, enumerable: true });
      return value;
    },
  });
  return projected;
}

/** Complete the canonical and distinct caller-shape facets at their single owner. */
export function completeActionInputHints(spec: ActionSpec): ActionSpec {
  const api = spec.surfaceBindings?.api;
  const agent = spec.surfaceBindings?.agent;
  const mcp = spec.surfaceBindings?.mcp;
  const toolHints = (binding: NonNullable<NonNullable<ActionSpec['surfaceBindings']>['agent']>) => withDerivedHints(binding, () => {
    const fields = readActionSchemaTopLevelFieldNames(binding.inputSchema);
    const authored = binding.inputHints ?? spec.inputHints;
    return fields && authored
      ? { ...authored, fields: authored.fields.filter(field => fields.has(field.path.split('.')[0]!)) }
      : authored;
  });
  const cli = spec.cli;
  return withDerivedHints({
    ...spec,
    ...(cli ? { cli: withDerivedHints({ ...cli,
      inputSchema: cli.inputSchema ?? spec.inputSchema,
    }, () => cli.inputHints ?? spec.inputHints, false) } : {}),
    ...(spec.surfaceBindings ? { surfaceBindings: { ...spec.surfaceBindings,
      ...(agent ? { agent: toolHints(agent) } : {}),
      ...(mcp ? { mcp: toolHints(mcp) } : {}),
      ...(api ? { api: withDerivedHints({ ...api, inputHints: api.inputHints ?? spec.inputHints }) } : {}),
    } } : {}),
  });
}
