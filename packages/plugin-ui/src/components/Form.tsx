import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import {
  actionInputOptionValueKey,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
  type ActionInputHints,
  type ActionInputOptionValue,
  type ActionInputPredicate,
} from '@happier-dev/plugin-sdk/actions';

import {
  HappierField,
  HappierForm,
  HappierFormActions,
  HappierSelect,
  HappierTextField,
  HappierToggle,
  HappierValidationMessage,
  useHappierFormSubmission,
} from '../presentation/form/Fields.js';
import {
  readHappierActionInputPath,
  resolveHappierActionFieldPresentation,
  writeHappierActionInputPath,
} from '../presentation/form/actionInputFields.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Stack } from './Layout.js';
import { Text } from './Text.js';

const FORM_SUBMIT_TRANSLATION_KEY = 'happier.plugin-ui.form.submit';
const FORM_CANCEL_TRANSLATION_KEY = 'happier.plugin-ui.form.cancel';

/**
 * The author-owned subset of Action-form presentation hints.
 *
 * The SDK's canonical Action schema also carries host producer instructions
 * (`optionsSourceId` and `connectedAccountOptions`). A mounted Form receives
 * only already-resolved author-visible values, so those instructions are
 * deliberately normalized out before this public component boundary.
 */
type FormHints = Readonly<{
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: readonly FormFieldHints[];
}>;

type FormOptionValue = string | Readonly<{
  service: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  accountId: string;
}>;

type FormOption = Readonly<{
  value: FormOptionValue;
  label: string;
  description?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>;

type FormHintOption = Readonly<{
  value: FormOptionValue;
  label: string;
  description?: string;
  disabled?: boolean;
}>;

type FormPrimitive = string | number | boolean | null;

type FormPredicate =
  | Readonly<{ op: 'truthy'; path: string }>
  | Readonly<{ op: 'eq'; path: string; value: FormPrimitive }>
  | Readonly<{ op: 'includes'; path: string; value: string }>
  | Readonly<{ op: 'not'; predicate: FormPredicate }>
  | Readonly<{ op: 'and'; all: readonly FormPredicate[] }>
  | Readonly<{ op: 'or'; any: readonly FormPredicate[] }>;

type FormFieldHints = Readonly<{
  path: string;
  title: string;
  description?: string;
  placeholder?: string;
  widget:
    | 'text'
    | 'url'
    | 'secret'
    | 'textarea'
    | 'number'
    | 'integer'
    | 'text_list'
    | 'select'
    | 'multiselect'
    | 'boolean'
    | 'json';
  required?: boolean;
  requireExplicitSelection?: boolean;
  listSeparator?: 'comma' | 'newline';
  maxSelections?: number;
  options?: readonly FormHintOption[];
  visibleWhen?: FormPredicate;
  requiredWhen?: FormPredicate;
  disabledWhen?: FormPredicate;
}>;

function toCanonicalActionInputOptionValue(value: FormOptionValue): ActionInputOptionValue {
  if (typeof value === 'string') return value;
  return {
    service: {
      pluginId: value.service.pluginId,
      localId: value.service.localId,
    },
    accountId: value.accountId,
  };
}

function fromCanonicalActionInputOptionValue(value: ActionInputOptionValue): FormOptionValue {
  if (typeof value === 'string') return value;
  return {
    service: {
      pluginId: value.service.pluginId,
      localId: value.service.localId,
    },
    accountId: value.accountId,
  };
}

function toCanonicalActionInputPredicate(predicate: FormPredicate): ActionInputPredicate {
  switch (predicate.op) {
    case 'truthy':
      return { op: 'truthy', path: predicate.path };
    case 'eq':
      return { op: 'eq', path: predicate.path, value: predicate.value };
    case 'includes':
      return { op: 'includes', path: predicate.path, value: predicate.value };
    case 'not':
      return { op: 'not', predicate: toCanonicalActionInputPredicate(predicate.predicate) };
    case 'and':
      return { op: 'and', all: predicate.all.map(toCanonicalActionInputPredicate) };
    case 'or':
      return { op: 'or', any: predicate.any.map(toCanonicalActionInputPredicate) };
  }
}

/** Normalize the curated author vocabulary into the canonical Action-form owner. */
function toCanonicalActionInputHints(hints: FormHints): ActionInputHints {
  return {
    ...(hints.title === undefined ? {} : { title: hints.title }),
    ...(hints.description === undefined ? {} : { description: hints.description }),
    ...(hints.submitLabel === undefined ? {} : { submitLabel: hints.submitLabel }),
    fields: hints.fields.map((field) => ({
      path: field.path,
      title: field.title,
      widget: field.widget,
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.requireExplicitSelection === undefined ? { } : { requireExplicitSelection: field.requireExplicitSelection }),
      ...(field.listSeparator === undefined ? {} : { listSeparator: field.listSeparator }),
      ...(field.maxSelections === undefined ? {} : { maxSelections: field.maxSelections }),
      ...(field.options === undefined ? {} : {
        options: field.options.map((option) => ({
          value: toCanonicalActionInputOptionValue(option.value),
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
          ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
        })),
      }),
      ...(field.visibleWhen === undefined ? {} : { visibleWhen: toCanonicalActionInputPredicate(field.visibleWhen) }),
      ...(field.requiredWhen === undefined ? {} : { requiredWhen: toCanonicalActionInputPredicate(field.requiredWhen) }),
      ...(field.disabledWhen === undefined ? {} : { disabledWhen: toCanonicalActionInputPredicate(field.disabledWhen) }),
    })),
  };
}

export type FieldProps = Readonly<{
  label: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  issue?: string;
  testID?: string;
  children?: ReactNode;
}>;

export function Field(props: FieldProps): ReactElement {
  return <HappierField {...props} theme={usePluginTheme()} />;
}

export type TextFieldProps = Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  secure?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric';
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
}>;

export function TextField(props: TextFieldProps): ReactElement {
  const { onChange, focusTarget, ...rest } = props;
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return <HappierTextField {...rest} onChangeText={onChange} controlRef={focusBinding} theme={usePluginTheme()} />;
}

export type ToggleProps = Readonly<{
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}>;

export function Toggle(props: ToggleProps): ReactElement {
  return <HappierToggle {...props} theme={usePluginTheme()} />;
}

export type SelectOption = FormOption;
export type SelectProps = Readonly<{
  label: string;
  options: readonly SelectOption[];
  value?: FormOptionValue | readonly FormOptionValue[];
  multiple?: boolean;
  maxSelections?: number;
  minimumSelections?: number;
  onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
  disabled?: boolean;
  testID?: string;
}>;

export function Select(props: SelectProps): ReactElement {
  return <HappierSelect
    {...props}
    value={props.value}
    theme={usePluginTheme()}
    isEqual={(left, right) => isSameActionInputOptionValue(
      toCanonicalActionInputOptionValue(left),
      toCanonicalActionInputOptionValue(right),
    )}
    keyForOption={(option) => actionInputOptionValueKey(toCanonicalActionInputOptionValue(option.value))}
  />;
}

export type ValidationMessageProps = Readonly<{ message: string; testID?: string }>;

export function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement {
  return <HappierValidationMessage message={message} theme={usePluginTheme()} testID={testID} />;
}

export type FormActionsProps = Readonly<{ children?: ReactNode }>;

function FormActions({ children }: FormActionsProps): ReactElement {
  return <HappierFormActions>{children}</HappierFormActions>;
}

export type FormProps = Readonly<{
  hints: FormHints;
  value: Readonly<Record<string, unknown>>;
  onChange: (value: Record<string, unknown>) => void;
  onSubmit: (value: Record<string, unknown>) => unknown;
  onCancel?: () => unknown;
  /** Author override for the host-localized default Cancel label. */
  cancelLabel?: string;
  issues?: Readonly<Record<string, string | undefined>>;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}>;

function readActionInputSelectionForPresentation(
  field: Pick<ActionInputHints['fields'][number], 'widget'>,
  value: unknown,
): FormOptionValue | readonly FormOptionValue[] | undefined {
  if (field.widget === 'select') {
    const optionValue = readActionInputOptionValue(value);
    return optionValue === undefined ? undefined : fromCanonicalActionInputOptionValue(optionValue);
  }
  if (field.widget !== 'multiselect') return undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const optionValue = readActionInputOptionValue(item);
    return optionValue === undefined ? [] : [fromCanonicalActionInputOptionValue(optionValue)];
  });
}

function FormRoot(props: FormProps): ReactElement {
  const hints = toCanonicalActionInputHints(props.hints);
  const spec = { inputHints: hints };
  const fields = resolveEffectiveActionInputFields(spec, props.value);
  const submission = useHappierFormSubmission(props.busy);
  const formDisabled = props.disabled === true || submission.pending;
  const patch = (path: string, value: unknown) => props.onChange(writeHappierActionInputPath(props.value, path, value));
  const translate = usePluginTranslation();
  const submitLabel = hints.submitLabel
    ?? translate(FORM_SUBMIT_TRANSLATION_KEY, 'Submit');
  const cancelLabel = props.cancelLabel
    ?? translate(FORM_CANCEL_TRANSLATION_KEY, 'Cancel');

  return (
    <HappierForm accessibilityLabel={hints.title} testID={props.testID} busy={submission.pending}>
      <Stack gap="medium">
      {hints.title ? <Heading value={hints.title} level={2} /> : null}
      {hints.description ? <Text value={hints.description} tone="secondary" /> : null}
      {fields.map((field) => {
        const value = readHappierActionInputPath(props.value, field.path);
        const presentation = resolveHappierActionFieldPresentation<FormOptionValue>(
          field,
          value,
          readActionInputSelectionForPresentation(field, value),
        );
        const disabled = formDisabled || field.disabled;
        const issue = props.issues?.[field.path];
        let control: ReactNode;
        if (presentation.kind === 'toggle') {
          control = <Toggle label={field.title} value={presentation.value} disabled={disabled} onChange={(next) => patch(field.path, next)} />;
        } else if (presentation.kind === 'select') {
          control = (
            <Select
              label={field.title}
              options={(field.options ?? []).map((option) => ({
                value: fromCanonicalActionInputOptionValue(option.value),
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
                ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
              }))}
              value={presentation.value}
              multiple={presentation.multiple}
              maxSelections={field.maxSelections}
              minimumSelections={field.required ? 1 : undefined}
              disabled={disabled}
              onChange={(next) => patch(field.path, next)}
            />
          );
        } else {
          control = (
            <TextField
              label={field.title}
              value={presentation.value}
              placeholder={field.placeholder}
              disabled={disabled}
              required={field.required}
              secure={presentation.secure}
              multiline={presentation.multiline}
              keyboardType={presentation.keyboardType}
              onChange={(next) => patch(field.path, presentation.parseText(next))}
            />
          );
        }
        return (
          <Field
            key={field.path}
            label={field.title}
            description={field.description}
            required={field.required}
            disabled={disabled}
            issue={issue}
          >
            {control}
          </Field>
        );
      })}
      <FormActions>
        <Button
          title={submitLabel}
          busy={submission.pending}
          disabled={formDisabled}
          onPress={() => submission.submit(() => props.onSubmit(
            normalizeActionInputByFieldHints(spec, { ...props.value }),
          ))}
        />
        {props.onCancel ? <Button title={cancelLabel} variant="secondary" disabled={props.disabled} onPress={props.onCancel} /> : null}
      </FormActions>
      </Stack>
    </HappierForm>
  );
}

export const Form = Object.assign(FormRoot, {
  Field: Field,
  TextField: TextField,
  Toggle: Toggle,
  Select: Select,
  ValidationMessage: ValidationMessage,
  Actions: FormActions,
});
