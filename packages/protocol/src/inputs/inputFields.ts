import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { InputTypeReferenceV1Schema, type InputTypeReferenceV1 } from './inputTypes.js';
import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { PluginUiIconTokenV1Schema, type PluginUiIconTokenV1 } from '../plugins/contributions/ui/tokens.js';
import { PluginProjectionBrandAssetV2Schema, PluginProjectionSourceV2Schema,
  type PluginProjectionBrandAssetV2, type PluginProjectionSourceV2 } from '../daemon/pluginCatalogPresentation.js';

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

export const InputOptionValueSchema: z.ZodMiniType<InputOptionValue> = lazyZodSchema(() => StrictJsonValueSchema.check(z.superRefine((value, context) => {
  // The incumbent credential ref remains a closed shape, not a generic JSON fallback.
  if (value && typeof value === 'object' && !Array.isArray(value)
    && ('service' in value || 'accountId' in value)
    && !QualifiedConnectedAccountRefSchema.safeParse(value).success) {
    context.addIssue({ code: 'custom', message: 'Invalid qualified Connected Account ref' });
  }
})));

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

const InputHintCoreFieldSchema = lazyZodSchema(() => z.strictObject({
  path: InputPathSchema,
  widget: InputWidgetSchema,
  /** Host semantic refs describe values and never confer read authority. */
  inputType: z.optional(InputTypeReferenceV1Schema),
  /** Missing preserves following compatible surface/group context. */
  contextMode: z.optional(z.enum(['follow', 'own'])),
  required: z.optional(z.boolean()),
  requireExplicitSelection: z.optional(z.boolean()),
  /** A string select may offer suggestions while accepting a new typed value. */
  allowCustomValue: z.optional(z.boolean()),
  listSeparator: z.optional(z.enum(['comma', 'newline'])),
  maxSelections: z.optional(z.number().check(z.int(), z.positive())),
  defaultValue: z.optional(StrictJsonValueSchema),
  /** Display hint for an integer: `bytes` is entered in GiB while the stored and submitted value stays bytes. */
  unit: z.optional(z.literal('bytes')),
  /** Saved provisioner size: CPU cores; memory/disk in GiB unless unit is bytes. */
  role: z.optional(z.enum(['cpu', 'memory', 'disk'])),
  visibleWhen: z.optional(InputPredicateSchema),
  /** Surface-aware editors show this field only when the host declares the named context slot. */
  visibleWhenContextSlot: z.optional(InputPathSchema),
  requiredWhen: z.optional(InputPredicateSchema),
  disabledWhen: z.optional(InputPredicateSchema),
}));

const InputHintCanonicalSourceShape = {
  optionsSourceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  connectedAccountOptions: z.optional(z.literal(true)),
  /**
   * Host-derived only: one authorized Connected Account request succeeded but
   * returned no options. Public plugin Action descriptors use the narrower
   * schema below and cannot manufacture this static-empty arm.
   */
  resolvedEmptyConnectedAccountOptions: z.optional(z.literal(true)),
};

const InputHintPluginActionSourceShape = {
  connectedAccountOptions: z.optional(z.literal(true)),
};

const InputHintStaticSourceShape = {};

export type InputHintOptionDescriptor<TText, TValue = InputOptionValue> = Readonly<{
  value: TValue;
  label: TText;
  /** Optional host localization key; the authored label remains the portable fallback. */
  labelKey?: string;
  description?: TText;
  disabled?: boolean;
  icon?: PluginUiIconTokenV1;
  brand?: PluginProjectionBrandAssetV2;
  source?: PluginProjectionSourceV2;
  /** Version of the declaring plugin, never an installed native package. */
  version?: string;
}>;

export type InputFieldHintDescriptor<TText, TValue = InputOptionValue> = Readonly<{
  path: string;
  title: TText;
  /** Optional setup question; title remains the noun used in summaries. */
  prompt?: TText;
  description?: TText;
  placeholder?: TText;
  widget: InputWidget;
  inputType?: InputTypeReferenceV1;
  /** Own values never follow surface/group context; omitted means follow-able. */
  contextMode?: 'follow' | 'own';
  required?: boolean;
  requireExplicitSelection?: boolean;
  /** Select suggestions do not constrain string values; the input type's schema and choices still apply. */
  allowCustomValue?: boolean;
  listSeparator?: 'comma' | 'newline';
  maxSelections?: number;
  /** Initial form value only; explicit draft values and later edits take precedence. */
  defaultValue?: JsonValue;
  /** An integer declared as `bytes` is entered in GiB; the stored and submitted value stays bytes. */
  unit?: 'bytes';
  /** Saved provisioner size: CPU cores; memory/disk in GiB unless unit is bytes. */
  role?: 'cpu' | 'memory' | 'disk';
  /** Choices restrict admitted values unless allowCustomValue is true; they never widen a type schema. */
  options?: readonly InputHintOptionDescriptor<TText, TValue>[];
  optionsSourceId?: string;
  connectedAccountOptions?: true;
  visibleWhen?: InputPredicate;
  visibleWhenContextSlot?: InputPath;
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
  context: z.core.$RefinementCtx,
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

  if (value.allowCustomValue !== undefined && widget !== 'select') {
    context.addIssue({ code: 'custom', path: ['allowCustomValue'], message: 'allowCustomValue is only valid for select fields.' });
  }

  const hasAllowedConnectedAccountOptions = validationOptions.allowConnectedAccountOptions && hasConnectedAccountOptions;
  if ((widget === 'select' || widget === 'multiselect') && !hasOptions && !hasOptionsSource && !hasAllowedConnectedAccountOptions && !hasResolvedEmptyConnectedAccountOptions) {
    context.addIssue({
      code: "custom",
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
      code: "custom",
      path: ['options'],
      message: 'Static options are only valid for select or multiselect fields.',
    });
  }
  if (widget === 'secret' && hasOptionsSource) {
    context.addIssue({
      code: "custom",
      path: ['optionsSourceId'],
      message: 'secret fields cannot declare an options source.',
    });
  }
  if (hasConnectedAccountOptions && widget !== 'select') {
    context.addIssue({
      code: "custom",
      path: ['connectedAccountOptions'],
      message: 'connectedAccountOptions is only valid for select fields.',
    });
  }
  if (hasConnectedAccountOptions && (hasDeclaredOptions || hasOptionsSource)) {
    context.addIssue({
      code: "custom",
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
      code: "custom",
      path: ['resolvedEmptyConnectedAccountOptions'],
      message: 'resolvedEmptyConnectedAccountOptions requires a static empty select field.',
    });
  }
  if (widget === 'text_list' && value.listSeparator === undefined) {
    context.addIssue({
      code: "custom",
      path: ['listSeparator'],
      message: 'text_list requires listSeparator.',
    });
  }
  if (widget !== 'text_list' && value.listSeparator !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['listSeparator'],
      message: 'listSeparator is only valid for text_list fields.',
    });
  }
  if (value.unit !== undefined && widget !== 'integer') {
    context.addIssue({
      code: "custom",
      path: ['unit'],
      message: 'unit is only valid for integer fields.',
    });
  }
  if (value.maxSelections !== undefined && widget !== 'multiselect') {
    context.addIssue({
      code: "custom",
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
  context: z.core.$RefinementCtx,
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
        code: "custom",
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
      code: "custom",
      path: ['fields', index, 'connectedAccountOptions'],
      message: 'Action input hints may declare at most one Connected Account options field.',
    });
  }

  fields.forEach(({ field, index }) => {
    for (const [otherPath, otherIndex] of seenPaths) {
      if (otherIndex === index) continue;
      if (isSameOrDescendantPath(field.path, otherPath)) {
        context.addIssue({
          code: "custom",
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
        code: "custom",
        path: ['fields', index],
        message: 'Action input predicates cannot read a secret field value.',
      });
    }
  });
}

function createInputHintsSchemasForSharedField<
  TText extends z.ZodMiniType,
  TOptionValue extends z.ZodMiniType,
  TSourceShape extends z.core.$ZodShape,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
  sourceShape: TSourceShape,
  validationOptions: InputHintFieldValidationOptions,
) {
  const optionSchema = z.strictObject({
    value: optionValueSchema,
    label: textSchema,
    labelKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
    description: z.optional(textSchema),
    disabled: z.optional(z.boolean()),
    icon: z.optional(PluginUiIconTokenV1Schema),
    brand: z.optional(PluginProjectionBrandAssetV2Schema),
    source: z.optional(PluginProjectionSourceV2Schema),
    version: z.optional(z.string().check(z.trim(), z.minLength(1))),
  });
  const fieldSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(InputHintCoreFieldSchema, {
    ...sourceShape,
    title: textSchema,
    prompt: z.optional(textSchema),
    description: z.optional(textSchema),
    placeholder: z.optional(textSchema),
    options: z.optional(z.readonly(z.array(optionSchema))),
  })).check(z.superRefine((value, context) => {
    validateInputHintField(value, context, validationOptions);
  })));
  const hintsSchema = z.strictObject({
    title: z.optional(textSchema),
    description: z.optional(textSchema),
    submitLabel: z.optional(textSchema),
    fields: z._default(z.readonly(z.array(fieldSchema)), []),
  }).check(z.superRefine((value, context) => {
    validateInputHintsCrossField(value.fields, context);
  }));
  return Object.freeze({ optionSchema, fieldSchema, hintsSchema });
}

export function createInputHintsSchemas<
  TText extends z.ZodMiniType,
  TOptionValue extends z.ZodMiniType,
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
  TText extends z.ZodMiniType,
  TOptionValue extends z.ZodMiniType,
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
  TText extends z.ZodMiniType,
  TOptionValue extends z.ZodMiniType,
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
  z.string().check(z.trim(), z.minLength(1)),
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
      ...(field.prompt === undefined ? {} : { prompt: resolveText(field.prompt) }),
      ...(field.description === undefined ? {} : { description: resolveText(field.description) }),
      ...(field.placeholder === undefined ? {} : { placeholder: resolveText(field.placeholder) }),
      widget: field.widget,
      ...(field.inputType === undefined ? {} : { inputType: field.inputType }),
      ...(field.contextMode === undefined ? {} : { contextMode: field.contextMode }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.requireExplicitSelection === undefined ? {} : { requireExplicitSelection: field.requireExplicitSelection }),
      ...(field.allowCustomValue === undefined ? {} : { allowCustomValue: field.allowCustomValue }),
      ...(field.listSeparator === undefined ? {} : { listSeparator: field.listSeparator }),
      ...(field.maxSelections === undefined ? {} : { maxSelections: field.maxSelections }),
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
      ...(field.unit === undefined ? {} : { unit: field.unit }),
      ...(field.role === undefined ? {} : { role: field.role }),
      ...(field.options === undefined ? {} : {
        options: field.options.map((option) => ({
          value: option.value,
          label: resolveText(option.label),
          ...(option.labelKey === undefined ? {} : { labelKey: option.labelKey }),
          ...(option.description === undefined ? {} : { description: resolveText(option.description) }),
          ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
          ...(option.icon === undefined ? {} : { icon: option.icon }),
          ...(option.brand === undefined ? {} : { brand: option.brand }),
          ...(option.source === undefined ? {} : { source: option.source }),
          ...(option.version === undefined ? {} : { version: option.version }),
        })),
      }),
      ...(field.optionsSourceId === undefined
        ? {}
        : { optionsSourceId: field.optionsSourceId }),
      ...(field.connectedAccountOptions === undefined ? {} : { connectedAccountOptions: field.connectedAccountOptions }),
      ...(field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen }),
      ...(field.visibleWhenContextSlot === undefined ? {} : { visibleWhenContextSlot: field.visibleWhenContextSlot }),
      ...(field.requiredWhen === undefined ? {} : { requiredWhen: field.requiredWhen }),
      ...(field.disabledWhen === undefined ? {} : { disabledWhen: field.disabledWhen }),
    })),
  });
}
