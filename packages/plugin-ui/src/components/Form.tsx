import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import {
  actionInputOptionValueKey,
  type ActionFormHints,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
  type ActionInputOptionValue,
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
import type { HappierTextSelection } from '../presentation/portableTypes.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Stack } from './Layout.js';
import { Text } from './Text.js';

const FORM_SUBMIT_TRANSLATION_KEY = 'happier.plugin-ui.form.submit';
const FORM_CANCEL_TRANSLATION_KEY = 'happier.plugin-ui.form.cancel';

type FormOptionValue = ActionInputOptionValue;

// Re-export the canonical narrowed Action vocabulary alongside FormProps so
// callers can author against the same type without reaching into internals.
export type { ActionFormFieldHint, ActionFormHints } from '@happier-dev/plugin-sdk/actions';

type FormOption = Readonly<{
  value: FormOptionValue;
  label: string;
  description?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>;


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

/**
 * A caret (`start === end`) or a selected range inside a text field.
 *
 * The author holds this between renders, so it carries a public name rather
 * than only appearing inline in a prop signature.
 */
export type TextSelection = HappierTextSelection;

export type TextFieldProps = Readonly<{
  label: string;
  labelKey?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  placeholderKey?: string;
  disabled?: boolean;
  required?: boolean;
  secure?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric';
  /**
   * Replaces the prose-entry capitalization this field otherwise derives from
   * `secure` and `keyboardType`. A search query is not a sentence.
   */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  /** Replaces the derived autocorrection, which also silences spellchecking. */
  autoCorrect?: boolean;
  /**
   * The caret or range this field shows. A controlled field whose value is
   * rewritten between keystrokes otherwise puts the caret at the end of the new
   * value, so the author keeps it here instead of losing the reader's place.
   */
  selection?: TextSelection;
  onSelectionChange?: (selection: TextSelection) => void;
  /**
   * Commits the field. It is composition-aware, so confirming an IME candidate
   * with Enter settles the composition rather than submitting a partial query.
   */
  onSubmitEditing?: () => void;
  /** Reports IME start/end without exposing a platform event. */
  onCompositionChange?: (isComposing: boolean) => void;
  /** Returns true when Escape was handled after the active composition yielded it. */
  onEscape?: () => boolean;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
}>;

export function TextField(props: TextFieldProps): ReactElement {
  const { onChange, focusTarget, label, labelKey, placeholder, placeholderKey, ...rest } = props;
  const translate = usePluginTranslation();
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return (
    <HappierTextField
      {...rest}
      label={resolveAuthorText(translate, label, labelKey) ?? label}
      placeholder={resolveAuthorText(translate, placeholder, placeholderKey)}
      onChangeText={onChange}
      controlRef={focusBinding}
      theme={usePluginTheme()}
    />
  );
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
  required?: boolean;
  onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
  disabled?: boolean;
  /** Logical focus target transferred to the first enabled option in this field. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
}>;

export function Select(props: SelectProps): ReactElement {
  const { focusTarget, ...rest } = props;
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return <HappierSelect
    {...rest}
    value={props.value}
    controlRef={focusBinding}
    theme={usePluginTheme()}
    isEqual={isSameActionInputOptionValue}
    keyForOption={(option) => actionInputOptionValueKey(option.value)}
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
  hints: ActionFormHints;
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
  field: Pick<ActionFormHints['fields'][number], 'widget'>,
  value: unknown,
): FormOptionValue | readonly FormOptionValue[] | undefined {
  if (field.widget === 'select') {
    const optionValue = readActionInputOptionValue(value);
    return optionValue;
  }
  if (field.widget !== 'multiselect') return undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const optionValue = readActionInputOptionValue(item);
    return optionValue === undefined ? [] : [optionValue];
  });
}

function FormRoot(props: FormProps): ReactElement {
  const hints = props.hints;
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
                value: option.value,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
                ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
              }))}
              value={presentation.value}
              multiple={presentation.multiple}
              maxSelections={field.maxSelections}
              minimumSelections={field.required ? 1 : undefined}
              required={field.required}
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
