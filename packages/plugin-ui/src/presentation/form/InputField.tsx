import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { resolveHappierActionFieldPresentation, type HappierActionInputField } from './actionInputFields.js';
import {
  HappierField,
  HappierSelect,
  HappierTextField,
  HappierToggle,
  HappierValidationMessage,
  type HappierSelectOption,
} from './Fields.js';
import { HappierInputPickerButton, useHappierInputPicker } from './inputPicker.js';

/**
 * The presentation slice of the one typed-field vocabulary (`@happier-dev/protocol/inputs`).
 * Visibility, requiredness and disabled state are already resolved by the input owner.
 */
export type HappierInputFieldDescriptor = HappierActionInputField & Readonly<{
  path: string;
  title: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  maxSelections?: number;
  inputType?: Readonly<{ pluginId: string; localId: string }>;
}>;

export type HappierInputFieldProps<Value> = Readonly<{
  field: HappierInputFieldDescriptor;
  /** The draft value at `field.path`. */
  value: unknown;
  /** The draft's selection, already read through the canonical option-value reader. */
  selection?: Value | readonly Value[];
  /** Choices from the host's one options read (or the field's static options). */
  options?: readonly HappierSelectOption<Value>[];
  /** While choices load or have failed, the selection stays visible but cannot change. */
  optionsStatus?: 'loading' | 'ready' | 'failed';
  /** The host's own state line for a failed options read, with its retry. */
  optionsNotice?: ReactNode;
  /** Receives the next value for `field.path`: parsed text, a boolean, a selection or a picked value. */
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** The owner's validation for this field. */
  issue?: string;
  isEqual?: (left: Value, right: Value) => boolean;
  keyForOption?: (option: HappierSelectOption<Value>, index: number) => string;
  /** `field` draws the label, description and issue; `none` leaves them to an enclosing row. */
  frame?: 'field' | 'none';
  /** A Toggle's accessible name when it should say more than the field title. */
  toggleLabel?: string;
  /** The control's test id (text input or toggle). */
  controlTestID?: string;
  testID?: string;
  style?: HappierStyleProp;
  theme: HappierUiTheme;
}>;

/**
 * One typed field, drawn the same wherever it appears: an Action's form, a Workflow's inputs,
 * a widget's setup and a plugin's public `Form`. It picks the control from the field (text,
 * switch, choices), shows the host's failed-options line, and offers the admitted custom
 * picker beneath the control. A picked value replaces the draft only when the host accepted it;
 * cancelling or a refused value leaves every entered value as it was.
 */
export function HappierInputField<Value>(props: HappierInputFieldProps<Value>): ReactElement {
  const { field, theme } = props;
  const presentation = resolveHappierActionFieldPresentation<Value>(field, props.value, props.selection);
  const optionsSettled = props.optionsStatus === undefined || props.optionsStatus === 'ready';
  const picker = useHappierInputPicker({
    field,
    value: props.value,
    // Only choices that actually arrived; the host refuses a typed answer it cannot check.
    ...(props.options === undefined || !optionsSettled ? {} : { options: props.options }),
    onSelect: props.onChange,
  });
  const disabled = props.disabled === true || field.disabled === true;
  let control: ReactNode;
  if (presentation.kind === 'toggle') {
    control = (
      <HappierToggle
        label={props.toggleLabel ?? field.title}
        value={presentation.value}
        disabled={disabled}
        theme={theme}
        testID={props.controlTestID}
        onChange={props.onChange}
      />
    );
  } else if (presentation.kind === 'select') {
    const options = props.options ?? [];
    // A picker-only type has no list to show; its control is the picker itself.
    control = options.length === 0 && picker.affordance !== null ? null : (
      <HappierSelect<Value>
        label={field.title}
        options={options}
        value={presentation.value}
        multiple={presentation.multiple}
        maxSelections={field.maxSelections}
        minimumSelections={presentation.multiple && field.required ? 1 : undefined}
        required={field.required}
        disabled={disabled || !optionsSettled}
        theme={theme}
        {...(props.isEqual === undefined ? {} : { isEqual: props.isEqual })}
        {...(props.keyForOption === undefined ? {} : { keyForOption: props.keyForOption })}
        onChange={props.onChange}
      />
    );
  } else {
    control = (
      <HappierTextField
        label={field.title}
        testID={props.controlTestID}
        placeholder={field.placeholder}
        required={field.required}
        disabled={disabled}
        value={presentation.value}
        secure={presentation.secure}
        keyboardType={presentation.keyboardType}
        multiline={presentation.multiline}
        theme={theme}
        onChangeText={(text) => props.onChange(presentation.parseText(text))}
      />
    );
  }
  const pickerButton = (
    <HappierInputPickerButton
      picker={picker}
      theme={theme}
      // A type with choices checks the picked value against them, so wait while they load.
      disabled={disabled || props.optionsStatus === 'loading'}
      {...(props.testID === undefined ? {} : { testID: `${props.testID}-picker` })}
    />
  );
  if (props.frame === 'none') {
    return (
      <View testID={props.testID} style={[{ gap: theme.spacing.small }, props.style]}>
        {control}
        {props.optionsStatus === 'failed' ? props.optionsNotice : null}
        {pickerButton}
        {picker.error !== null ? (
          <HappierValidationMessage message={picker.error} theme={theme} accessibilityLiveRegion="polite" />
        ) : null}
      </View>
    );
  }
  return (
    <HappierField
      label={field.title}
      description={field.description}
      required={field.required}
      disabled={disabled}
      issue={props.issue || picker.error || undefined}
      theme={theme}
      testID={props.testID}
      style={props.style}
    >
      {control}
      {props.optionsStatus === 'failed' ? props.optionsNotice : null}
      {pickerButton}
    </HappierField>
  );
}
