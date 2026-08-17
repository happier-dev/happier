import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import {
  QualifiedConnectedAccountRefSchema,
} from '../connect/qualifiedConnectedAccountPersistence.js';
import {
  ActionInputPathSchema,
  ActionInputPredicateSchema,
  type ActionInputPath,
  type ActionInputPredicate,
} from './actionInputPredicates.js';

export { ActionInputPathSchema, type ActionInputPath };

export const ActionInputWidgetSchema = z.enum([
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
]);
export type ActionInputWidget = z.infer<typeof ActionInputWidgetSchema>;

/**
 * The normalized Action-form option arm is intentionally narrow. A Connected
 * Account option can carry only its exact qualified ref; purpose, provider,
 * credentials, and account inventory stay host-owned.
 */
export type ActionInputOptionValue = string | {
  service: {
    pluginId: string;
    localId: string;
  };
  accountId: string;
};

export const ActionInputOptionValueSchema: z.ZodType<ActionInputOptionValue> = z.union([
  z.string().min(1),
  asProtocolZod(QualifiedConnectedAccountRefSchema),
]);

/** Reads an untrusted draft/control value without admitting a second ref parser. */
export function readActionInputOptionValue(value: unknown): ActionInputOptionValue | undefined {
  const parsed = ActionInputOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isSameActionInputOptionValue(
  left: ActionInputOptionValue,
  right: ActionInputOptionValue,
): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.accountId === right.accountId
    && left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId;
}

/** Stable semantic selection/key identity without coercing structured values. */
export function actionInputOptionValueKey(value: ActionInputOptionValue): string {
  return typeof value === 'string'
    ? `string:${value}`
    : JSON.stringify([
      'connected-account',
      value.service.pluginId,
      value.service.localId,
      value.accountId,
    ]);
}

/** Structured refs are selectable, but their identifiers are never catalog search text. */
export function actionInputOptionValueSearchText(value: ActionInputOptionValue): string {
  return typeof value === 'string' ? value : '';
}

const ActionInputHintCoreFieldSchema = z.object({
  path: ActionInputPathSchema,
  widget: ActionInputWidgetSchema,
  required: z.boolean().optional(),
  requireExplicitSelection: z.boolean().optional(),
  listSeparator: z.enum(['comma', 'newline']).optional(),
  maxSelections: z.number().int().positive().optional(),
  visibleWhen: ActionInputPredicateSchema.optional(),
  requiredWhen: ActionInputPredicateSchema.optional(),
  disabledWhen: ActionInputPredicateSchema.optional(),
}).strict();

const ActionInputHintCanonicalSourceShape = {
  optionsSourceId: z.string().trim().min(1).optional(),
  connectedAccountOptions: z.literal(true).optional(),
  /**
   * Host-derived only: one authorized Connected Account request succeeded but
   * returned no options. Public plugin Action descriptors use the narrower
   * schema below and cannot manufacture this static-empty arm.
   */
  resolvedEmptyConnectedAccountOptions: z.literal(true).optional(),
};

const ActionInputHintPluginActionSourceShape = {
  connectedAccountOptions: z.literal(true).optional(),
};

const ActionInputHintStaticSourceShape = {};

export type ActionInputHintOptionDescriptor<TText, TValue = ActionInputOptionValue> = Readonly<{
  value: TValue;
  label: TText;
  description?: TText;
  disabled?: boolean;
}>;

export type ActionInputFieldHintDescriptor<TText, TValue = ActionInputOptionValue> = Readonly<{
  path: string;
  title: TText;
  description?: TText;
  placeholder?: TText;
  widget: ActionInputWidget;
  required?: boolean;
  requireExplicitSelection?: boolean;
  listSeparator?: 'comma' | 'newline';
  maxSelections?: number;
  options?: readonly ActionInputHintOptionDescriptor<TText, TValue>[];
  optionsSourceId?: string;
  connectedAccountOptions?: true;
  visibleWhen?: ActionInputPredicate;
  requiredWhen?: ActionInputPredicate;
  disabledWhen?: ActionInputPredicate;
}>;

export type ActionInputHintsDescriptor<TText, TValue = ActionInputOptionValue> = Readonly<{
  title?: TText;
  description?: TText;
  submitLabel?: TText;
  fields: readonly ActionInputFieldHintDescriptor<TText, TValue>[];
}>;

type ActionInputHintFieldValidationOptions = Readonly<{
  allowOptionsSourceId: boolean;
  allowConnectedAccountOptions: boolean;
}>;

const CanonicalActionInputHintFieldValidationOptions: ActionInputHintFieldValidationOptions = {
  allowOptionsSourceId: true,
  allowConnectedAccountOptions: true,
};

const PluginActionInputHintFieldValidationOptions: ActionInputHintFieldValidationOptions = {
  allowOptionsSourceId: false,
  allowConnectedAccountOptions: true,
};

const StaticActionInputHintFieldValidationOptions: ActionInputHintFieldValidationOptions = {
  allowOptionsSourceId: false,
  allowConnectedAccountOptions: false,
};

function validateActionInputHintField(
  value: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
  validationOptions: ActionInputHintFieldValidationOptions = CanonicalActionInputHintFieldValidationOptions,
): void {
  const widget = value.widget;
  const options = value.options;
  const hasDeclaredOptions = Array.isArray(options);
  const hasOptions = Array.isArray(options) && options.length > 0;
  const hasOptionsSource = typeof value.optionsSourceId === 'string' && value.optionsSourceId.trim().length > 0;
  const hasConnectedAccountOptions = value.connectedAccountOptions === true;
  const hasResolvedEmptyConnectedAccountOptions = value.resolvedEmptyConnectedAccountOptions === true;

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

function readPredicatePaths(predicate: unknown): readonly string[] {
  if (!predicate || typeof predicate !== 'object') return [];
  const fields = new Map(Object.entries(predicate));
  switch (fields.get('op')) {
    case 'truthy':
    case 'eq':
    case 'includes': {
      const path = fields.get('path');
      return typeof path === 'string' ? [path] : [];
    }
    case 'not':
      return readPredicatePaths(fields.get('predicate'));
    case 'and': {
      const all = fields.get('all');
      return Array.isArray(all)
        ? all.flatMap((entry) => readPredicatePaths(entry))
        : [];
    }
    case 'or': {
      const any = fields.get('any');
      return Array.isArray(any)
        ? any.flatMap((entry) => readPredicatePaths(entry))
        : [];
    }
    default:
      return [];
  }
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}.`);
}

type ActionInputHintCrossField = Readonly<{
  path: string;
  widget: unknown;
  staticOptionCount: number;
  connectedAccountOptions: boolean;
  visibleWhen: unknown;
  requiredWhen: unknown;
  disabledWhen: unknown;
}>;

/** Reads only the cross-field facts already structurally owned by the schema. */
function readActionInputHintCrossField(value: unknown): ActionInputHintCrossField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = new Map(Object.entries(value));
  const path = fields.get('path');
  if (typeof path !== 'string') return null;
  const options = fields.get('options');
  return {
    path,
    widget: fields.get('widget'),
    staticOptionCount: Array.isArray(options) ? options.length : 0,
    connectedAccountOptions: fields.get('connectedAccountOptions') === true,
    visibleWhen: fields.get('visibleWhen'),
    requiredWhen: fields.get('requiredWhen'),
    disabledWhen: fields.get('disabledWhen'),
  };
}

function validateActionInputHintsCrossField(
  rawFields: readonly unknown[],
  context: z.RefinementCtx,
): void {
  const fields = rawFields.flatMap((rawField, index) => {
    const field = readActionInputHintCrossField(rawField);
    return field ? [{ field, index }] : [];
  });
  const seenPaths = new Map<string, number>();
  let staticOptionCount = 0;
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
    staticOptionCount += field.staticOptionCount;
    if (field.widget === 'secret') secretPaths.add(field.path);
    if (field.connectedAccountOptions) connectedAccountOptionFieldIndexes.push(index);
  });

  if (staticOptionCount > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields'],
      message: 'Action input hints may declare at most 256 static options in total.',
    });
  }

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
      ...readPredicatePaths(field.visibleWhen),
      ...readPredicatePaths(field.requiredWhen),
      ...readPredicatePaths(field.disabledWhen),
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

function createActionInputHintsSchemasForSharedField<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
  TSourceShape extends z.core.$ZodShape,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
  sourceShape: TSourceShape,
  validationOptions: ActionInputHintFieldValidationOptions,
) {
  const optionSchema = z.object({
    value: optionValueSchema,
    label: textSchema,
    description: textSchema.optional(),
    disabled: z.boolean().optional(),
  }).strict();
  const fieldSchema = ActionInputHintCoreFieldSchema.extend({
    ...sourceShape,
    title: textSchema,
    description: textSchema.optional(),
    placeholder: textSchema.optional(),
    options: z.array(optionSchema).max(256).readonly().optional(),
  }).strict().superRefine((value, context) => {
    validateActionInputHintField(value, context, validationOptions);
  });
  const hintsSchema = z.object({
    title: textSchema.optional(),
    description: textSchema.optional(),
    submitLabel: textSchema.optional(),
    fields: z.array(fieldSchema).max(64).readonly().default([]),
  }).strict().superRefine((value, context) => {
    validateActionInputHintsCrossField(value.fields, context);
  });
  return Object.freeze({ optionSchema, fieldSchema, hintsSchema });
}

export function createActionInputHintsSchemas<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createActionInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    ActionInputHintCanonicalSourceShape,
    CanonicalActionInputHintFieldValidationOptions,
  );
}

/**
 * Public plugin authors cannot select an arbitrary option producer. The
 * normalized host grammar remains separate because it receives one bounded
 * host-produced Connected Account option result after authorization.
 */
export function createActionInputHintsSchemasWithoutOptionsSource<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createActionInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    ActionInputHintPluginActionSourceShape,
    PluginActionInputHintFieldValidationOptions,
  );
}

/** Static-only form grammar for public surfaces that cannot request host options. */
export function createActionInputHintsSchemasWithStaticOptionsOnly<
  TText extends z.ZodTypeAny,
  TOptionValue extends z.ZodTypeAny,
>(
  textSchema: TText,
  optionValueSchema: TOptionValue,
) {
  return createActionInputHintsSchemasForSharedField(
    textSchema,
    optionValueSchema,
    ActionInputHintStaticSourceShape,
    StaticActionInputHintFieldValidationOptions,
  );
}

const CanonicalActionInputHintsSchemas = createActionInputHintsSchemas(
  z.string().trim().min(1),
  ActionInputOptionValueSchema,
);

export const ActionInputOptionSchema = CanonicalActionInputHintsSchemas.optionSchema;
export type ActionInputOption = z.infer<typeof ActionInputOptionSchema>;
export const ActionInputFieldHintSchema = CanonicalActionInputHintsSchemas.fieldSchema;
export type ActionInputFieldHint = z.infer<typeof ActionInputFieldHintSchema>;
export const ActionInputHintsSchema = CanonicalActionInputHintsSchemas.hintsSchema;
export type ActionInputHints = z.infer<typeof ActionInputHintsSchema>;

export function normalizeActionInputHintsText<TText>(
  hints: ActionInputHintsDescriptor<TText>,
  resolveText: (value: TText) => string,
): ActionInputHints {
  return ActionInputHintsSchema.parse({
    ...(hints.title === undefined ? {} : { title: resolveText(hints.title) }),
    ...(hints.description === undefined ? {} : { description: resolveText(hints.description) }),
    ...(hints.submitLabel === undefined ? {} : { submitLabel: resolveText(hints.submitLabel) }),
    fields: hints.fields.map((field) => ({
      path: field.path,
      title: resolveText(field.title),
      ...(field.description === undefined ? {} : { description: resolveText(field.description) }),
      ...(field.placeholder === undefined ? {} : { placeholder: resolveText(field.placeholder) }),
      widget: field.widget,
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
      ...(field.optionsSourceId === undefined ? {} : { optionsSourceId: field.optionsSourceId }),
      ...(field.connectedAccountOptions === undefined ? {} : { connectedAccountOptions: field.connectedAccountOptions }),
      ...(field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen }),
      ...(field.requiredWhen === undefined ? {} : { requiredWhen: field.requiredWhen }),
      ...(field.disabledWhen === undefined ? {} : { disabledWhen: field.disabledWhen }),
    })),
  });
}
