import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette, useOptionalHappierUiLocalization } from '../../environment/context.js';
import { resolveHappierActionFieldPresentation, resolveHappierChoiceControl, type HappierActionInputField } from './actionInputFields.js';
import {
  HappierField,
  HappierTextField,
  HappierToggle,
  HappierValidationMessage,
  planHappierSelectOptions,
  resolveHappierFieldTextColors,
  type HappierSelectOption,
} from './Fields.js';
import { HappierChoiceField } from './ChoiceField.js';
import { HappierSegmentedChoice } from './SegmentedChoice.js';
import { HappierInputPickerButton, useHappierInputPicker } from './inputPicker.js';
import { HappierStatus } from '../status/Status.js';
import { HappierBodyEdgeContext } from '../layout/columnEdge.js';

/**
 * The presentation slice of the one typed-field vocabulary (`@happier-dev/protocol/inputs`).
 * Visibility, requiredness and disabled state are already resolved by the input owner.
 */
export type HappierInputFieldDescriptor = HappierActionInputField & Readonly<{
  path: string;
  title: string;
  prompt?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  maxSelections?: number;
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
  /** Host-bound navigation offered alongside a settled empty options inventory. */
  optionsEmptyAction?: ReactNode;
  /** Host-owned binding affordance; typed value controls and picker behavior remain field-owned. */
  leading?: ReactNode;
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
  /** The host's reading of the value: a picker-only field shows it in its trigger, and a choice field while its options cannot name it (still loading, or gone). */
  valueLabel?: string;
  /** A host's request to show the choices now (a repair, a keyboard hand-off); each new positive value opens them. */
  openRequest?: number;
  /** Optional host binding around the choice field's existing visibility/search owner. */
  renderChoiceControls?: ComponentProps<typeof HappierChoiceField<Value>>['renderControls'];
  /** Bind a custom picker's existing opener without replacing its picker or value admission. */
  renderPicker?: (control: Readonly<{ label: string; disabled: boolean; open: () => Promise<void>;
    render: (open: () => Promise<void>) => ReactNode }>) => ReactNode;
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
  // The unit symbol is not a translation: a byte-size integer is entered in GiB, and its label says so.
  const label = `${field.prompt ?? field.title}${field.widget === 'integer' && field.unit === 'bytes' ? ' (GiB)' : ''}`;
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
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const localization = useOptionalHappierUiLocalization();
  const allowsCustomValue = field.allowCustomValue === true;
  // A picker-only type has no list to show: its field box is the picker's trigger.
  const pickerOnly = presentation.kind === 'select' && !allowsCustomValue && (props.options ?? []).length === 0 && picker.affordance !== null;
  // Nothing to choose from: the field box stays and reads its value; there is no blank list to open.
  const noChoices = presentation.kind === 'select' && !allowsCustomValue && optionsSettled && props.options?.length === 0 && !pickerOnly;
  const optionsNoticeContent = props.optionsStatus === 'failed' ? props.optionsNotice
    : props.optionsStatus === 'loading' && presentation.kind === 'select' && !allowsCustomValue
      ? <HappierStatus label={localization?.translate('happier.plugin-ui.state.loading', 'Loading') ?? 'Loading'}
          tone="neutral" indicator={false} theme={theme} />
    : noChoices
      ? <HappierStatus label={localization?.translate('happier.plugin-ui.select.empty', 'No options available') ?? 'No options available'}
          tone="neutral" indicator={false} theme={theme}
          action={!disabled && props.optionsStatus === 'ready' ? props.optionsEmptyAction : undefined} />
      : null;
  // A field's notice (its choices failed to load) stands on the field's own edge, under its box: it adds no
  // list row's inset or glyph column, so even a narrow field (a binding inside a step card) reads it by words.
  const optionsNotice = optionsNoticeContent == null || optionsNoticeContent === false ? null
    : <HappierBodyEdgeContext.Provider value>{optionsNoticeContent}</HappierBodyEdgeContext.Provider>;
  const renderPicker = (render: (open: () => Promise<void>) => ReactNode) => props.renderPicker && picker.affordance
    ? props.renderPicker({ label: picker.affordance.label, disabled: disabled || !optionsSettled, open: picker.open, render })
    : render(picker.open);
  let control: ReactNode;
  if (presentation.kind === 'toggle') {
    control = (
      <HappierToggle
        label={props.toggleLabel ?? label}
        value={presentation.value}
        disabled={disabled}
        theme={theme}
        testID={props.controlTestID}
        onChange={props.onChange}
      />
    );
  } else if (presentation.kind === 'select' && !allowsCustomValue && resolveHappierChoiceControl(presentation, props.options ?? []) === 'segmented') {
    // Two to four short choices: one segmented control, the same shape as every other few-way choice.
    const plan = planHappierSelectOptions<Value>({
      options: props.options ?? [],
      value: presentation.value,
      disabled: disabled || !optionsSettled,
      ...(props.isEqual === undefined ? {} : { isEqual: props.isEqual }),
      ...(props.keyForOption === undefined ? {} : { keyForOption: props.keyForOption }),
    });
    control = (
      <HappierSegmentedChoice
        accessibilityLabel={label}
        segments={plan.options.map((entry) => ({
          key: entry.key,
          label: entry.option.label,
          selected: entry.selected,
          disabled: entry.disabled,
          ...(entry.option.accessibilityLabel === undefined ? {} : { accessibilityLabel: entry.option.accessibilityLabel }),
          ...(entry.option.testID === undefined ? {} : { testID: entry.option.testID }),
        }))}
        onSelect={(index) => {
          const entry = plan.options[index];
          if (entry === undefined || entry.disabled || entry.selected) return;
          props.onChange(entry.nextValue());
        }}
        disabled={disabled || !optionsSettled}
        colors={{
          track: palette.segmentTrack,
          thumb: palette.segmentThumb,
          ...(palette.segmentThumbLift === undefined ? {} : { thumbLift: palette.segmentThumbLift }),
          label: theme.colors.secondaryText,
          activeLabel: theme.colors.text,
          focusRing: theme.colors.focus,
        }}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}.segmented` })}
      />
    );
  } else if (presentation.kind === 'select') {
    const options = props.options ?? [];
    control = pickerOnly ? renderPicker(open => (
      // A picker-only type has no list to show: its field box reads the value and opens the picker.
      <HappierChoiceField<Value>
        label={label}
        options={options}
        value={presentation.value}
        placeholder={picker.affordance?.label}
        {...(props.valueLabel === undefined ? {} : { reading: props.valueLabel })}
        // The host checks a picked value against the choices: while they load, or after their read
        // failed, Browse cannot succeed, so it waits (the failed line's Retry is the next step).
        disabled={disabled || !optionsSettled}
        theme={theme}
        onOpen={() => { void open(); }}
        onChange={props.onChange}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}-picker` })}
      />
    )) : (
      <HappierChoiceField<Value>
        label={label}
        options={options}
        value={presentation.value}
        multiple={presentation.multiple}
        maxSelections={field.maxSelections}
        minimumSelections={presentation.multiple && field.required ? 1 : undefined}
        required={field.required}
        placeholder={field.placeholder}
        {...(allowsCustomValue ? { customValue: {
          value: typeof props.value === 'string' ? props.value : '',
          onChange: props.onChange,
          testID: props.controlTestID,
        } } : {})}
        {...(props.valueLabel === undefined ? {} : { reading: props.valueLabel })}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
        {...(props.openRequest === undefined ? {} : { openRequest: props.openRequest })}
        {...(props.renderChoiceControls === undefined ? {} : { renderControls: props.renderChoiceControls })}
        disabled={disabled || !allowsCustomValue && (!optionsSettled || noChoices)}
        theme={theme}
        {...(props.isEqual === undefined ? {} : { isEqual: props.isEqual })}
        {...(props.keyForOption === undefined ? {} : { keyForOption: props.keyForOption })}
        onChange={props.onChange}
      />
    );
  } else {
    control = (
      <HappierTextField
        label={label}
        // The same field box as a choice field's trigger beside it, never a borderless well.
        appearance="field"
        fieldColors={resolveHappierFieldTextColors(palette, theme)}
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
  const pickerButton = pickerOnly ? null : renderPicker(open => (
    <HappierInputPickerButton
      picker={{ ...picker, open }}
      theme={theme}
      // A type with choices checks the picked value against them, so wait while they load or failed.
      disabled={disabled || !optionsSettled}
      {...(props.testID === undefined ? {} : { testID: `${props.testID}-picker` })}
    />
  ));
  if (props.frame === 'none') {
    return (
      <View testID={props.testID} style={[{ gap: theme.spacing.small }, props.style]}>
        {props.leading}
        {control}
        {optionsNotice}
        {pickerButton}
        {picker.error !== null ? (
          <HappierValidationMessage message={picker.error} theme={theme} accessibilityLiveRegion="polite" />
        ) : null}
      </View>
    );
  }
  return (
    <HappierField
      label={label}
      description={field.description}
      required={field.required}
      disabled={disabled}
      issue={props.issue || picker.error || undefined}
      theme={theme}
      testID={props.testID}
      style={props.style}
    >
      {props.leading}
      {control}
      {optionsNotice}
      {pickerButton}
    </HappierField>
  );
}
