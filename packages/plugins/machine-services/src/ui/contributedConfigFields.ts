import { createElement as h, type ReactElement } from 'react';
import {
  Button,
  Column,
  Columns,
  Field,
  Row,
  Select,
  Stack,
  TextField,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

/**
 * Typed fields for an installed check kind, drawn from the configuration schema it declares (the closed JSON-schema
 * subset kinds publish: objects, strings, numbers, enums, kind-tagged variants and lists of records). The draft keeps
 * what the person typed; `contributedConfigValue` turns it into the configuration the kind's schema then validates.
 */
type Schema = Readonly<Record<string, unknown>>;
type Draft = unknown;
type Translate = ReturnType<typeof usePluginTranslation>;
const K = 'machineServices.healthSetup.contributed';

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
const schemaOf = (value: unknown): Schema => record(value);
const properties = (schema: Schema) =>
  Object.entries(record(schema.properties)).map(
    ([key, value]) => [key, schemaOf(value)] as const,
  );
const required = (schema: Schema) =>
  new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
/** A closed set of words: `enum`, or a union of string constants (`anyOf: [{ const: 'above' }, …]`). */
const enumOf = (schema: Schema): string[] | null => {
  if (Array.isArray(schema.enum)) return schema.enum.filter((value): value is string => typeof value === 'string');
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) return null;
  const constants = schema.anyOf.map(schemaOf).map((option) => option.const);
  return constants.every((value): value is string => typeof value === 'string') ? constants : null;
};
const typeOf = (schema: Schema) =>
  typeof schema.type === 'string' ? schema.type : null;

/** A property name in words ("serviceName" → "Service name"); a declared title wins. */
function labelFor(key: string, schema: Schema): string {
  if (typeof schema.title === 'string' && schema.title.length > 0)
    return schema.title;
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Object variants tagged by one constant property (`kind: 'route' | 'runtime' | …`). */
function variants(
  schema: Schema,
): readonly Readonly<{ tag: string; value: string; schema: Schema }>[] | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const found = schema.anyOf.map(schemaOf).map((option) => {
    const tagged = properties(option).find(
      ([, property]) => typeof property.const === 'string',
    );
    return tagged
      ? { tag: tagged[0], value: tagged[1].const as string, schema: option }
      : null;
  });
  return found.every((item) => item !== null) &&
    found.length > 0 &&
    found.every((item) => item!.tag === found[0]!.tag)
    ? (found as { tag: string; value: string; schema: Schema }[])
    : null;
}

/** The starting draft: declared defaults, the first choice of an enum or variant, one empty record in a required list. */
export function contributedConfigDraft(schema: Schema, seed?: unknown): Draft {
  if (
    seed !== undefined &&
    schema.const === undefined &&
    typeOf(schema) !== 'object' &&
    !schema.anyOf &&
    typeOf(schema) !== 'array'
  ) {
    return typeof seed === 'number' ? String(seed) : seed;
  }
  if (schema.const !== undefined) return schema.const;
  const tagged = variants(schema);
  if (tagged) {
    const chosen =
      tagged.find((option) => record(seed)[option.tag] === option.value) ??
      tagged[0]!;
    return contributedConfigDraft(chosen.schema, seed);
  }
  if (typeOf(schema) === 'object') {
    const seeded = record(seed);
    return Object.fromEntries(
      properties(schema).map(([key, property]) => [
        key,
        contributedConfigDraft(property, seeded[key]),
      ]),
    );
  }
  if (typeOf(schema) === 'array') {
    const items = schemaOf(schema.items);
    if (Array.isArray(seed))
      return seed.map((item) => contributedConfigDraft(items, item));
    return typeof schema.minItems === 'number' && schema.minItems > 0
      ? [contributedConfigDraft(items)]
      : [];
  }
  if (schema.default !== undefined)
    return typeof schema.default === 'number'
      ? String(schema.default)
      : schema.default;
  return enumOf(schema)?.[0] ?? '';
}

/** The configuration the draft says: trimmed text, parsed numbers, and empty optional fields left out. */
export function contributedConfigValue(schema: Schema, draft: Draft): unknown {
  if (schema.const !== undefined) return schema.const;
  const tagged = variants(schema);
  if (tagged) {
    const chosen =
      tagged.find((option) => record(draft)[option.tag] === option.value) ??
      tagged[0]!;
    return contributedConfigValue(chosen.schema, draft);
  }
  const type = typeOf(schema);
  if (type === 'object') {
    const values = record(draft);
    return Object.fromEntries(
      properties(schema).flatMap(([key, property]) => {
        const value = contributedConfigValue(property, values[key]);
        // An empty field is left out: a required one then keeps the check unavailable, as empty native fields do.
        return value === undefined || value === '' ? [] : [[key, value]];
      }),
    );
  }
  if (type === 'array')
    return (Array.isArray(draft) ? draft : []).map((item) =>
      contributedConfigValue(schemaOf(schema.items), item),
    );
  if (type === 'number' || type === 'integer') {
    const text = typeof draft === 'string' ? draft.trim() : '';
    return text === '' || !Number.isFinite(Number(text))
      ? undefined
      : Number(text);
  }
  return typeof draft === 'string' ? draft.trim() : draft;
}

type FieldProps = Readonly<{
  schema: Schema;
  label: string;
  draft: Draft;
  optional: boolean;
  testID: string;
  onChange: (next: Draft) => void;
  t: Translate;
}>;

/** One property: a field, a select, a tagged variant, a nested group or a list of records. */
function SchemaField(props: FieldProps): ReactElement | null {
  const { schema, label, draft, t } = props;
  if (schema.const !== undefined) return null;
  const tagged = variants(schema);
  if (tagged) {
    const chosen =
      tagged.find((option) => record(draft)[option.tag] === option.value) ??
      tagged[0]!;
    return h(
      Stack,
      { gap: 'medium' },
      h(
        Field,
        { label },
        h(Select, {
          label,
          presentation: 'field',
          value: chosen.value,
          testID: props.testID,
          options: tagged.map((option) => ({
            value: option.value,
            label: labelFor(option.value, {}),
          })),
          onChange: (next) => {
            const option = tagged.find((item) => item.value === next);
            if (option) props.onChange(contributedConfigDraft(option.schema));
          },
        }),
      ),
      h(ObjectFields, {
        schema: chosen.schema,
        draft,
        onChange: props.onChange,
        testID: props.testID,
        t,
      }),
    );
  }
  const type = typeOf(schema);
  if (type === 'object') {
    return h(
      Field,
      { label },
      h(ObjectFields, {
        schema,
        draft,
        onChange: props.onChange,
        testID: props.testID,
        t,
        inline: true,
      }),
    );
  }
  if (type === 'array' && typeOf(schemaOf(schema.items)) === 'object') {
    const items = Array.isArray(draft) ? draft : [];
    const itemSchema = schemaOf(schema.items);
    const minimum = typeof schema.minItems === 'number' ? schema.minItems : 0;
    return h(
      Field,
      { label },
      h(
        Stack,
        { gap: 'small' },
        ...items.map((item, index) =>
          h(
            Row,
            { key: index, gap: 'small', align: 'flex-end' },
            h(
              Stack,
              { grow: true },
              h(ObjectFields, {
                schema: itemSchema,
                draft: item,
                testID: `${props.testID}-${index}`,
                t,
                inline: true,
                onChange: (next) =>
                  props.onChange(
                    items.map((current, position) =>
                      position === index ? next : current,
                    ),
                  ),
              }),
            ),
            items.length > minimum
              ? h(Button, {
                  title: t(`${K}.remove`, 'Remove'),
                  variant: 'secondary',
                  onPress: () =>
                    props.onChange(
                      items.filter((_, position) => position !== index),
                    ),
                })
              : null,
          ),
        ),
        h(
          Row,
          {},
          h(Button, {
            title: t(`${K}.addItem`, 'Add another'),
            variant: 'secondary',
            testID: `${props.testID}-add`,
            onPress: () =>
              props.onChange([...items, contributedConfigDraft(itemSchema)]),
          }),
        ),
      ),
    );
  }
  const choices = enumOf(schema);
  if (choices) {
    return h(
      Field,
      { label },
      h(Select, {
        label,
        presentation: 'field',
        value: typeof draft === 'string' ? draft : choices[0],
        testID: props.testID,
        options: choices.map((value) => ({
          value,
          label: labelFor(value, {}),
        })),
        onChange: (next) => {
          if (typeof next === 'string') props.onChange(next);
        },
      }),
    );
  }
  const numeric = type === 'number' || type === 'integer';
  return h(
    Field,
    {
      label,
      required: !props.optional,
      ...(typeof schema.description === 'string'
        ? { description: schema.description }
        : {}),
    },
    h(TextField, {
      label,
      value: typeof draft === 'string' ? draft : '',
      presentation: 'field',
      testID: props.testID,
      onChange: props.onChange,
      ...(numeric
        ? { keyboardType: 'numeric' as const }
        : { autoCapitalize: 'none' as const, autoCorrect: false }),
    }),
  );
}

/** An object's properties; a small group (a threshold, a route) sits in columns that recompose to one on phones. */
function ObjectFields(
  props: Readonly<{
    schema: Schema;
    draft: Draft;
    onChange: (next: Draft) => void;
    testID: string;
    t: Translate;
    inline?: boolean;
  }>,
): ReactElement {
  const values = record(props.draft);
  const needed = required(props.schema);
  const fields = properties(props.schema).flatMap(([key, property]) =>
    property.const !== undefined
      ? []
      : [
          h(SchemaField, {
            key,
            schema: property,
            label: labelFor(key, property),
            draft: values[key],
            optional: !needed.has(key),
            testID: `${props.testID}-${key}`,
            t: props.t,
            onChange: (next) => props.onChange({ ...values, [key]: next }),
          }),
        ],
  );
  const simple =
    props.inline &&
    fields.length > 1 &&
    fields.length <= 3 &&
    properties(props.schema).every(
      ([, property]) =>
        typeOf(property) !== 'object' &&
        typeOf(property) !== 'array' &&
        !property.anyOf,
    );
  return simple
    ? h(
        Columns,
        { columns: fields.length as 2 | 3, minColumnWidth: 140 },
        ...fields.map((field, index) => h(Column, { key: index }, field)),
      )
    : h(Stack, { gap: 'medium' }, ...fields);
}

/** The installed kind's configuration as typed fields. */
export function ContributedConfigFields(
  props: Readonly<{
    schema: Schema;
    draft: Draft;
    onChange: (next: Draft) => void;
  }>,
): ReactElement {
  const t = usePluginTranslation();
  return h(ObjectFields, {
    schema: props.schema,
    draft: props.draft,
    onChange: props.onChange,
    testID: 'health-setup-contributed',
    t,
  });
}
