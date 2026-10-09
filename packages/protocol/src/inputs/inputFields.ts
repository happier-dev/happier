import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { inputTypeOptionsSourceId } from './inputTypes.js';
import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

import {
  QualifiedConnectedAccountRefSchema,
} from '../connect/qualifiedConnectedAccountPersistence.js';
import {
  InputPathSchema,
  InputPredicateSchema,
  readInputPredicatePaths,
  type InputPath,
  type InputPredicate,
} from './inputPredicates.js';

export { InputPathSchema, type InputPath };

export const InputWidgetSchema = lazyZodSchema(() => z.enum([
  'text',
  'url',
  'secret',
  'textarea',
  'number',
  'integer',
  'text_list',
  'select',
  'multiselect',
  'boolean',
  'json',
]));
export type InputWidget = z.infer<typeof InputWidgetSchema>;

/**
 * Choices carry strict JSON so plugin schemas can describe primitives and
 * semantic refs. Connected Account refs retain their exact closed shape;
 * purpose, credentials and inventory authority stay host-owned.
 */
export type InputOptionValue = JsonValue;

export const InputOptionValueSchema: z.ZodType<InputOptionValue> = lazyZodSchema(() => StrictJsonValueSchema.superRefine((value, context) => {
  // The incumbent credential ref remains a closed shape, not a generic JSON fallback.
  if (value && typeof value === 'object' && !Array.isArray(value)
    && ('service' in value || 'accountId' in value)
    && !QualifiedConnectedAccountRefSchema.safeParse(value).success) {
    context.addIssue({ code: 'custom', message: 'Invalid qualified Connected Account ref' });
  }
}));

/** Reads an untrusted draft/control value without admitting a second ref parser. */
export function readInputOptionValue(value: unknown): InputOptionValue | undefined {
  const parsed = InputOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isSameInputOptionValue(
  left: InputOptionValue,
  right: InputOptionValue,
): boolean {
  return pluginJsonValuesEqual(left, right);
}

/** Stable semantic selection/key identity without coercing structured values. */
export function inputOptionValueKey(value: InputOptionValue): string {
  return typeof value === 'string'
    ? `string:${value}`
    : createCanonicalJsonSigningInput(value);
}

/** Structured refs are selectable, but their identifiers are never catalog search text. */
export function inputOptionValueSearchText(value: InputOptionValue): string {
  return typeof value === 'string' ? value : '';
}

const InputHintCoreFieldSchema = lazyZodSchema(() => z.object({
  path: InputPathSchema,
  widget: InputWidgetSchema,
  inputType: asProtocolZod(PluginContributionIdentityV1Schema).optional(),
  required: z.boolean().optional(),
  requireExplicitSelection: z.boolean().optional(),
  listSeparator: z.enum(['comma', 'newline']).optional(),
  maxSelections: z.number().int().positive().optional(),
  visibleWhen: InputPredicateSchema.optional(),
  requiredWhen: InputPredicateSchema.optional(),
  disabledWhen: InputPredicateSchema.optional(),
}).strict());

const InputHintCanonicalSourceShape = {
  optionsSourceId: z.string().trim().min(1).optional(),
  connectedAccountOptions: z.literal(true).optional(),
  /**
   * Host-derived only: one authorized Connected Account request succeeded but
   * returned no options. Public plugin Action descriptors use the narrower
   * schema below and cannot manufacture this static-empty arm.
   */
  resolvedEmptyConnectedAccountOptions: z.literal(true).optional(),
};

const InputHintPluginActionSourceShape = {
  connectedAccountOptions: z.literal(true).optional(),
};

const InputHintStaticSourceShape = {};

export type InputHintOptionDescriptor<TText, TValue = InputOptionValue> = Readonly<{
  value: TValue;
  label: TText;
  description?: TText;
  disabled?: boolean;
}>;

export type InputFieldHintDescriptor<TText, TValue = InputOptionValue> = Readonly<{
  path: string;
  title: TText;
  description?: TText;
  placeholder?: TText;
  widget: InputWidget;
  inputType?: PluginContributionIdentityV1;
  required?: boolean;
  requireExplicitSelection?: boolean;
  listSeparator?: 'comma' | 'newline';
  maxSelections?: number;
  options?: readonly InputHintOptionDescriptor<TText, TValue>[];
  optionsSourceId?: string;
  connectedAccountOptions?: true;
  visibleWhen?: InputPredicate;
  requiredWhen?: InputPredicate;
  disabledWhen?: InputPredicate;
}>;

export type InputHintsDescriptor<TText, TValue = InputOptionValue> = Readonly<{
  title?: TText;
  description?: TText;
  submitLabel?: TText;
  fields: readonly InputFieldHintDescriptor<TText, TValue>[];
}>;

type InputHintFieldValidationOptions = Readonly<{
  allowOptionsSourceId: boolean;
  allowConnectedAccountOptions: boolean;
}>;

const CanonicalInputHintFieldValidationOptions: InputHintFieldValidationOptions = {
  allowOptionsSourceId: true,
  allowConnectedAccountOptions: true,
};

const PluginInputHintFieldValidationOptions: InputHintFieldValidationOptions = {
  allowOptionsSourceId: false,
  allowConnectedAccountOptions: true,
};

const StaticInputHintFieldValidationOptions: InputHintFieldValidationOptions = {
  allowOptionsSourceId: false,
  allowConnectedAccountOptions: false,
};

function validateInputHintField(
  value: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
  validationOptions: InputHintFieldValidationOptions = CanonicalInputHintFieldValidationOptions,
): void {
  const widget = value.widget;
  const options = value.options;
  const hasDeclaredOptions = Array.isArray(options);
  const hasOptions = Array.isArray(options) && options.length > 0;
  const hasOptionsSource = (typeof value.optionsSourceId === 'string' && value.optionsSourceId.trim().length > 0)
    || value.inputType !== undefined;
  const hasConnectedAccountOptions = value.connectedAccountOptions === true;
  const hasResolvedEmptyConnectedAccountOptions = value.resolvedEmptyConnectedAccountOptions === true;
  if (value.inputType !== undefined && hasDeclaredOptions) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'An input type owns its choices; field-level static options would compete with it.' });
  }
  if (value.inputType !== undefined && value.optionsSourceId !== undefined) {
    const type = PluginContributionIdentityV1Schema.safeParse(value.inputType);
    if (type.success && value.optionsSourceId !== inputTypeOptionsSourceId(type.data)) {
      context.addIssue({ code: 'custom', path: ['optionsSourceId'], message: 'An input type cannot declare a competing options source.' });
    }
  }

  const hasAllowedConnectedAccountOptions = validationOptions.allowConnectedAccountOptions && hasConnectedAccountOptions;
  if ((widget === 'select' || widget === 'multiselect') && !hasOptions && !hasOptionsSource && !hasAllowedConnectedAccountOptions && !hasResolvedEmptyConnectedAccountOptions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: validationOptions.allowOptionsSourceId
        ? `${widget} requires options or optionsSourceId.`
        : validationOptions.allowConnectedAccountOptions
          ? `${widget} requires options or connectedAccountOptions.`
          : `${widget} requires static options.`,
    });
  }
  if (widget !== 'select' && widget !== 'multiselect' && hasDeclaredOptions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Static options are only valid for select or multiselect fields.',
    });
  }
  if (widget === 'secret' && hasOptionsSource) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['optionsSourceId'],
      message: 'secret fields cannot declare an options source.',
    });
  }
  if (hasConnectedAccountOptions && widget !== 'select') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectedAccountOptions'],
      message: 'connectedAccountOptions is only valid for select fields.',
    });
  }
  if (hasConnectedAccountOptions && (hasDeclaredOptions || hasOptionsSource)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectedAccountOptions'],
      message: validationOptions.allowOptionsSourceId
        ? 'connectedAccountOptions cannot be combined with static options or optionsSourceId.'
        : 'connectedAccountOptions cannot be combined with static options.',
    });
  }
  if (hasResolvedEmptyConnectedAccountOptions && (
    widget !== 'select'
    || !hasDeclaredOptions
    || hasOptions
    || hasOptionsSource
    || hasConnectedAccountOptions
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedEmptyConnectedAccountOptions'],
      message: 'resolvedEmptyConnectedAccountOptions requires a static empty select field.',
    });
  }
  if (widget === 'text_list' && value.listSeparator === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listSeparator'],
      message: 'text_list requires listSeparator.',
    });
  }
  if (widget !== 'text_list' && value.listSeparator !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['listSeparator'],
      message: 'listSeparator is only valid for text_list fields.',
    });
  }
  if (value.maxSelections !== undefined && widget !== 'multiselect') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSelections'],
      message: 'maxSelections is only valid for multiselect fields.',
    });
  }
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}.`);
}

type InputHintCrossField = Readonly<{
  path: string;
  widget: unknown;
  connectedAccountOptions: boolean;
  visibleWhen: unknown;
  requiredWhen: unknown;
  disabledWhen: unknown;
}>;

/** Reads only the cross-field facts already structurally owned by the schema. */
function readInputHintCrossField(value: unknown): InputHintCrossField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = new Map(Object.entries(value));
  const path = fields.get('path');
  if (typeof path !== 'string') return null;
  return {
    path,
    widget: fields.get('widget'),
    connectedAccountOptions: fields.get('connectedAccountOptions') === true,
    visibleWhen: fields.get('visibleWhen'),
    requiredWhen: fields.get('requiredWhen'),
    disabledWhen: fields.get('disabledWhen'),
  };
}

function validateInputHintsCrossField(
  rawFields: readonly unknown[],
  context: z.RefinementCtx,
): void {
  const fields = rawFields.flatMap((rawField, index) => {
    const field = readInputHintCrossField(rawField);
    return field ? [{ field, index }] : [];
  });
  const seenPaths = new Map<string, number>();
  const secretPaths = new Set<string>();
  const connectedAccountOptionFieldIndexes: number[] = [];

  fields.forEach(({ field, index }) => {
    const priorIndex = seenPaths.get(field.path);
    if (priorIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'path'],
        message: `Action input field path duplicates fields.${priorIndex}.path.`,
      });
    } else {
      seenPaths.set(field.path, index);
    }
    if (field.widget === 'secret') secretPaths.add(field.path);
    if (field.connectedAccountOptions) connectedAccountOptionFieldIndexes.push(index);
  });

  for (const index of connectedAccountOptionFieldIndexes.slice(1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields', index, 'connectedAccountOptions'],
      message: 'Action input hints may declare at most one Connected Account options field.',
    });
  }

  fields.forEach(({ field, index }) => {
    for (const [otherPath, otherIndex] of seenPaths) {
      if (otherIndex === index) continue;
      if (isSameOrDescendantPath(field.path, otherPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'path'],
          message: `Action input field paths cannot be ancestors or descendants of fields.${otherIndex}.path.`,
        });
        break;
      }
    }

    const predicatePaths = [
      ...readInputPredicatePaths(field.visibleWhen),
      ...readInputPredicatePaths(field.requiredWhen),
      ...readInputPredicatePaths(field.disabledWhen),
    ];
    if (predicatePaths.some((path) => [...secretPaths].some((secretPath) => isSameOrDescendantPath(path, secretPath)))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index],
        message: 'Action input predicates cannot read a secret field value.',
      });
    }
  });
}

function createInputHintsSchemasForSharedField<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
  TSourceShape extends z.core.$ZodShape,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
  sourceShape: TSourceShape,
  validationOptions: InputHintFieldValidationOptions,
) {
  const optionSchema = z.object({
    value: optionValueSchema,
    label: textSchema,
    description: textSchema.optional(),
    disabled: z.boolean().optional(),
  }).strict();
  const fieldSchema = InputHintCoreFieldSchema.extend({
    ...sourceShape,
    title: textSchema,
    description: textSchema.optional(),
    placeholder: textSchema.optional(),
    options: z.array(optionSchema).readonly().optional(),
  }).strict().superRefine((value, context) => {
    validateInputHintField(value, context, validationOptions);
  });
  const hintsSchema = z.object({
    title: textSchema.optional(),
    description: textSchema.optional(),
    submitLabel: textSchema.optional(),
    fields: z.array(fieldSchema).readonly().default([]),
  }).strict().superRefine((value, context) => {
    validateInputHintsCrossField(value.fields, context);
  });
  return Object.freeze({ optionSchema, fieldSchema, hintsSchema });
}

export function createInputHintsSchemas<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    InputHintCanonicalSourceShape,
    CanonicalInputHintFieldValidationOptions,
  );
}

/**
 * Public plugin authors cannot select an arbitrary option producer. The
 * normalized host grammar remains separate because it receives one bounded
 * host-produced Connected Account option result after authorization.
 */
export function createInputHintsSchemasWithoutOptionsSource<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    InputHintPluginActionSourceShape,
    PluginInputHintFieldValidationOptions,
  );
}

/** Static-only form grammar for public surfaces that cannot request host options. */
export function createInputHintsSchemasWithStaticOptionsOnly<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    InputHintStaticSourceShape,
    StaticInputHintFieldValidationOptions,
  );
}

const CanonicalInputHintsSchemas = createInputHintsSchemas(
  z.string().trim().min(1),
  InputOptionValueSchema,
);

export const InputOptionSchema = CanonicalInputHintsSchemas.optionSchema;
export type InputOption = z.infer<typeof InputOptionSchema>;
export const InputFieldHintSchema = CanonicalInputHintsSchemas.fieldSchema;
export type InputFieldHint = z.infer<typeof InputFieldHintSchema>;
export const InputHintsSchema = CanonicalInputHintsSchemas.hintsSchema;
export type InputHints = z.infer<typeof InputHintsSchema>;

export function normalizeInputHintsText<TText>(
  hints: InputHintsDescriptor<TText>,
  resolveText: (value: TText) => string,
): InputHints {
  return InputHintsSchema.parse({
    ...(hints.title === undefined ? {} : { title: resolveText(hints.title) }),
    ...(hints.description === undefined ? {} : { description: resolveText(hints.description) }),
    ...(hints.submitLabel === undefined ? {} : { submitLabel: resolveText(hints.submitLabel) }),
    fields: hints.fields.map((field) => ({
      path: field.path,
      title: resolveText(field.title),
      ...(field.description === undefined ? {} : { description: resolveText(field.description) }),
      ...(field.placeholder === undefined ? {} : { placeholder: resolveText(field.placeholder) }),
      widget: field.widget,
      ...(field.inputType === undefined ? {} : { inputType: field.inputType }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.requireExplicitSelection === undefined ? {} : { requireExplicitSelection: field.requireExplicitSelection }),
      ...(field.listSeparator === undefined ? {} : { listSeparator: field.listSeparator }),
      ...(field.maxSelections === undefined ? {} : { maxSelections: field.maxSelections }),
      ...(field.options === undefined ? {} : {
        options: field.options.map((option) => ({
          value: option.value,
          label: resolveText(option.label),
          ...(option.description === undefined ? {} : { description: resolveText(option.description) }),
          ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
        })),
      }),
      ...(field.optionsSourceId === undefined
        ? {}
        : { optionsSourceId: field.optionsSourceId }),
      ...(field.connectedAccountOptions === undefined ? {} : { connectedAccountOptions: field.connectedAccountOptions }),
      ...(field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen }),
      ...(field.requiredWhen === undefined ? {} : { requiredWhen: field.requiredWhen }),
      ...(field.disabledWhen === undefined ? {} : { disabledWhen: field.disabledWhen }),
    })),
  });
}
