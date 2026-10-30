import { useState, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  actionInputOptionValueKey,
  type ActionFormHints,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
  seedInputByFieldHints,
  type ActionInputOptionValue,
} from '@happier-dev/plugin-sdk/actions';

import {
  HappierField,
  HappierForm,
  HappierFormActions,
  HappierSelect,
  HappierTextField,
  type HappierTextFieldProps,
  HappierToggle,
  HappierValidationMessage,
  planHappierSelectOptions,
  useHappierFormSubmission,
  useHappierIsWithinField,
} from '../presentation/form/Fields.js';
import {
  readHappierActionInputPath,
  writeHappierActionInputPath,
} from '../presentation/form/actionInputFields.js';
import { HappierInputField } from '../presentation/form/InputField.js';
import { HAPPIER_SEGMENTED_METRICS, HappierSegmentedChoice } from '../presentation/form/SegmentedChoice.js';
import { resolveHappierSegmentedChoiceRow } from '../presentation/form/SegmentedChoiceRow.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import {
  resolveHappierFieldKeyboardType,
  useHappierFieldValueDraft,
  type HappierFieldValueKind,
} from '../presentation/form/fieldValueDraft.js';
import type { HappierTextSelection } from '../presentation/portableTypes.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette } from '../environment/context.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { HappierLocalDateTimeField } from '../presentation/form/LocalDateTimeField.js';
import type { HappierLocalDateTimeDraft } from '../presentation/form/localDateTimeValue.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Row, Stack } from './Layout.js';
import { Text } from './Text.js';
import { DictationButton, type DictationButtonProps } from './Voice.js';
import { Dropdown, type MenuItem } from './Overlay.js';
import { OverlayFieldTriggerContext } from './overlayFieldTrigger.js';

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
  unavailableReason?: string;
  /**
   * A segmented option's leading icon ("List" with its rows); decorative, the label names the option.
   * A `compact` segmented Select shows it alone.
   */
  icon?: IconName;
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
  /** Independent host Dictation. Receives editable words; the author decides insertion, never submission. */
  dictation?: Omit<DictationButtonProps, 'disabled'>;
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
  /**
   * `form` (default): a form field with its visible label. `field`: the
   * configuration page's bordered field box, placed as an `Item` row's
   * `accessory` — the row's title names it, so `label` is its accessible name
   * only — exactly like Happier's own page text fields.
   */
  presentation?: 'form' | 'field';
  /**
   * `field` only: typed in place and saved on leaving. The field keeps a local
   * draft (reported through `onChange`) and calls this once when focus leaves
   * or on submit, only when the draft differs from `value`. Return the text to
   * show afterwards (a clamped number, the saved value when refused), or
   * nothing to keep the draft.
   */
  onCommit?: (draft: string) => string | void;
  /** `field` with `onCommit`: `integer` and `decimal` keep the draft to digits and open a number keyboard. */
  kind?: 'text' | 'integer' | 'decimal';
  /** A number that may be left empty ("not set"); otherwise an emptied number returns to `value`. */
  allowEmpty?: boolean;
  /** `field` only: the field's refusal, shown beneath the box and announced. */
  error?: string;
  testID?: string;
}>;

export function TextField({ dictation, ...props }: TextFieldProps): ReactElement {
  return <Row gap="small" align="flex-start">
    <View style={{ flex: 1, minWidth: 0 }}><TextFieldControl {...props} /></View>
    {dictation === undefined ? null : <DictationButton {...dictation} disabled={props.disabled} />}
  </Row>;
}

function TextFieldControl(props: Omit<TextFieldProps, 'dictation'>): ReactElement {
  const {
    onChange,
    focusTarget,
    label,
    labelKey,
    placeholder,
    placeholderKey,
    presentation = 'form',
    onCommit,
    kind,
    allowEmpty,
    error,
    ...rest
  } = props;
  const translate = usePluginTranslation();
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const resolvedLabel = resolveAuthorText(translate, label, labelKey) ?? label;
  const resolvedPlaceholder = resolveAuthorText(translate, placeholder, placeholderKey);
  if (presentation === 'field' && palette !== null) {
    const fieldColors = {
      borderColor: palette.controlBorder,
      backgroundColor: palette.fieldBackground,
      edge: palette.controlEdge,
      valueColor: theme.colors.text,
      placeholderColor: palette.placeholder,
      errorColor: theme.colors.danger,
    };
    if (onCommit !== undefined) {
      return (
        <CommittingFieldTextField
          {...rest}
          label={resolvedLabel}
          placeholder={resolvedPlaceholder}
          onChange={onChange}
          onCommit={onCommit}
          kind={kind ?? 'text'}
          allowEmpty={allowEmpty}
          error={error}
          fieldColors={fieldColors}
          controlRef={focusBinding}
        />
      );
    }
    return (
      <HappierTextField
        {...rest}
        appearance="field"
        fieldColors={fieldColors}
        error={error}
        label={resolvedLabel}
        placeholder={resolvedPlaceholder}
        onChangeText={onChange}
        controlRef={focusBinding}
        theme={theme}
      />
    );
  }
  return (
    <HappierTextField
      {...rest}
      label={resolvedLabel}
      placeholder={resolvedPlaceholder}
      onChangeText={onChange}
      controlRef={focusBinding}
      theme={theme}
    />
  );
}

/** A page field that keeps a local draft and saves it on leaving, through the shared draft owner. */
function CommittingFieldTextField(props: Omit<TextFieldProps, 'dictation' | 'labelKey' | 'placeholderKey' | 'focusTarget' | 'presentation'> & Readonly<{
  onCommit: (draft: string) => string | void;
  kind: HappierFieldValueKind;
  fieldColors: NonNullable<HappierTextFieldProps['fieldColors']>;
  controlRef: HappierTextFieldProps['controlRef'];
}>): ReactElement {
  const { value, onChange, onCommit, kind, allowEmpty, error, fieldColors, controlRef, onSubmitEditing, ...rest } = props;
  const theme = usePluginTheme();
  const field = useHappierFieldValueDraft({ value, onCommit, onDraftChange: onChange, kind, allowEmpty });
  return (
    <HappierTextField
      {...rest}
      appearance="field"
      fieldColors={fieldColors}
      error={error}
      value={field.draft}
      onChangeText={field.change}
      onBlur={field.commit}
      onSubmitEditing={() => { field.commit(); onSubmitEditing?.(); }}
      keyboardType={resolveHappierFieldKeyboardType(kind) ?? rest.keyboardType}
      controlRef={controlRef}
      theme={theme}
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
  /**
   * `inline` (the default) lays every option out as its own control — right
   * for a form where comparing a few described choices is the task. `menu`
   * shows one compact trigger naming the field and its current choice (quiet
   * words with a caret), and opens the options in the shared menu — right for toolbar pickers such as
   * a view, a sort order or a filter facet. `field` is a settings-page row's
   * select: a field box showing the chosen option (or asking for one) that
   * opens the same menu; the row's title names the field, so `label` is only
   * its accessible name. `segmented` is a settings-page row's two-to-four-way
   * choice of short labels on one track; it chooses exactly one value and
   * rejects `multiple`. Every presentation applies the same selection rules.
   */
  presentation?: 'inline' | 'menu' | 'field' | 'segmented';
  /**
   * Segmented only: fit a narrow toolbar (List | Board on a phone). Each option with an `icon`
   * shows the icon alone and its label becomes its accessible name; an option without an icon
   * keeps its label. The control keeps its height, its radio-group semantics and its keys.
   */
  compact?: boolean;
  /**
   * Segmented only: take the container's whole width, the options sharing it equally (a panel's
   * level choice that leads what follows). Without it the track is as wide as its labels.
   */
  fill?: boolean;
  /** Logical focus target transferred to the first enabled option in this field. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
}>;

export function Select(props: SelectProps): ReactElement {
  const { focusTarget, presentation = 'inline', ...rest } = props;
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  const theme = usePluginTheme();
  const withinField = useHappierIsWithinField();
  if (presentation === 'menu' || presentation === 'field') {
    return <SelectMenu {...props} appearance={presentation} />;
  }
  if (presentation === 'segmented') return <SelectSegmented {...props} />;
  const control = (
    <HappierSelect
      {...rest}
      value={props.value}
      controlRef={focusBinding}
      theme={theme}
      isEqual={isSameActionInputOptionValue}
      keyForOption={(option) => actionInputOptionValueKey(option.value)}
    />
  );
  // Inside a Field the Field draws the name; standalone, the Select must, or
  // its options read as unlabeled tiles.
  if (withinField) return control;
  return (
    <HappierField label={props.label} required={props.required} disabled={props.disabled} theme={theme}>
      {control}
    </HappierField>
  );
}

/** Joins a field name to its current choice on a compact trigger. */
const SELECT_MENU_SEPARATOR = ' · ';

const SELECT_FIELD_PLACEHOLDER_TRANSLATION_KEY = 'happier.plugin-ui.select.choose';
const SELECT_FIELD_COUNT_TRANSLATION_KEY = 'happier.plugin-ui.select.count';

function planFormSelect(props: SelectProps) {
  return planHappierSelectOptions({
    options: props.options,
    value: props.value,
    ...(props.multiple === undefined ? {} : { multiple: props.multiple }),
    ...(props.maxSelections === undefined ? {} : { maxSelections: props.maxSelections }),
    ...(props.minimumSelections === undefined ? {} : { minimumSelections: props.minimumSelections }),
    ...(props.required === undefined ? {} : { required: props.required }),
    isEqual: isSameActionInputOptionValue,
    keyForOption: (option) => actionInputOptionValueKey(option.value),
  });
}

function SelectMenu(props: SelectProps & Readonly<{ appearance: 'menu' | 'field' }>): ReactElement {
  const [open, setOpen] = useState(false);
  const translate = usePluginTranslation();
  const plan = planFormSelect(props);
  const chosen = plan.options.filter((entry) => entry.selected);
  // One choice is named; several are counted, so the trigger stays compact. A field box stands alone
  // beside its row title, so its count says what it counts; a toolbar menu's trailing number is enough.
  const summary = chosen.length === 0
    ? null
    : chosen.length === 1 ? chosen[0]!.option.label
      : props.appearance === 'field'
        ? translate(SELECT_FIELD_COUNT_TRANSLATION_KEY, `${chosen.length} selected`, { count: chosen.length })
        : String(chosen.length);
  const placeholder = translate(SELECT_FIELD_PLACEHOLDER_TRANSLATION_KEY, 'Choose…');
  const trigger = props.appearance === 'field'
    ? summary ?? placeholder
    : summary === null ? props.label : `${props.label}${SELECT_MENU_SEPARATOR}${summary}`;
  const accessibilityLabel = chosen.length === 0
    ? props.label
    : `${props.label}: ${chosen.map((entry) => entry.option.label).join(', ')}`;
  const radioGroupId = 'select';
  const items: MenuItem[] = plan.options.map((entry) => (props.multiple
    ? { id: entry.key, label: entry.option.label, kind: 'checkbox', checked: entry.selected, disabled: entry.disabled }
    : { id: entry.key, label: entry.option.label, kind: 'radio', radioGroupId, disabled: entry.disabled }));
  const dropdown = (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      // A field draws its own box around the control trigger; a toolbar menu is quiet words with a caret, the
      // same form as the toolbar's other pickers (a view, a filter), so a sort order is not a button face.
      {...(props.appearance === 'field'
        ? { triggerAppearance: 'control' as const }
        : { triggerAppearance: 'text' as const, triggerDisclosure: true })}
      triggerAccessibilityLabel={accessibilityLabel}
      disabled={props.disabled || items.length === 0}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      items={items}
      {...(props.multiple || items.length === 0
        ? {}
        : {
            radioGroups: [{
              id: radioGroupId,
              accessibilityLabel: props.label,
              selectedId: chosen[0]?.key ?? null,
            }],
          })}
      onSelect={(id) => {
        const entry = plan.options.find((candidate) => candidate.key === id);
        if (entry === undefined || entry.disabled) return;
        props.onChange(entry.nextValue());
      }}
    />
  );
  return props.appearance === 'field'
    ? (
      <OverlayFieldTriggerContext.Provider value={{ value: summary, placeholder }}>
        {dropdown}
      </OverlayFieldTriggerContext.Provider>
    )
    : dropdown;
}

/** A segment's leading icon: the label's own slot, in the label's own ink, so an icon never makes a segment taller. */
function segmentLeading(icon: IconName | undefined, selected: boolean): Readonly<{ leading?: ReactElement }> {
  if (icon === undefined) return {};
  return {
    leading: (
      <PluginUiIconGlyph name={icon} size={HAPPIER_SEGMENTED_METRICS.labelSlotPx.default} tone={selected ? 'neutral' : 'secondary'} />
    ),
  };
}

/** A single choice among a few short labels, drawn as a segmented control. */
function SelectSegmented(props: SelectProps): ReactElement {
  if (props.multiple) {
    throw new Error('Select presentation="segmented" chooses exactly one value; use "inline" or "menu" for a multiple Select.');
  }
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const plan = planFormSelect(props);
  // The plan carries the shared option shape; a segment's icon is read back from the author's own option.
  const iconByKey = new Map(props.options.flatMap((option) => (
    option.icon === undefined ? [] : [[actionInputOptionValueKey(option.value), option.icon] as const]
  )));
  const model = resolveHappierSegmentedChoiceRow({
    options: plan.options.map((entry) => ({
      ...entry.option,
      id: entry.key,
      disabled: entry.disabled,
      ...segmentLeading(iconByKey.get(entry.key), entry.selected),
    })),
    value: plan.options.find((entry) => entry.selected)?.key ?? '',
  });
  return (
    <View>
    <HappierSegmentedChoice
      accessibilityLabel={props.label}
      segments={model.segments.map((segment, index) => ({
        ...segment,
        key: segment.id,
        testID: plan.options[index]?.option.testID,
      }))}
      onSelect={(index) => {
        const entry = plan.options[index];
        if (entry === undefined || model.segments[index]?.disabled || entry.selected) return;
        props.onChange(entry.nextValue());
      }}
      disabled={props.disabled}
      iconOnly={props.compact === true}
      fill={props.fill === true}
      colors={{
        track: palette.segmentTrack,
        thumb: palette.segmentThumb,
        thumbLift: palette.segmentThumbLift,
        label: theme.colors.secondaryText,
        activeLabel: theme.colors.text,
        focusRing: theme.colors.focus,
      }}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
    {model.detail ? <Text variant="meta" tone="secondary" value={model.detail} /> : null}
    </View>
  );
}

/**
 * A local wall-clock reading: `YYYY-MM-DD` and `HH:mm` where the reader is. Read the instant it names
 * with `resolveHappierFutureLocalDateTime` from `@happier-dev/plugin-ui/components`.
 */
export type LocalDateTimeValue = HappierLocalDateTimeDraft;

export type LocalDateTimeFieldProps = Readonly<{
  /** The instant the reading must be after; also the picker's earliest day. */
  nowMs: number;
  value: LocalDateTimeValue;
  onChange: (value: LocalDateTimeValue) => void;
  labels: Readonly<{ date: string; time: string; pastInstant: string }>;
  testIDPrefix: string;
}>;

/**
 * One local date and time, typed or picked (a lease's end, an expiry, a reminder). Each field opens the
 * host's own date or time picker where it has one; otherwise the reader types the reading.
 */
export function LocalDateTimeField(props: LocalDateTimeFieldProps): ReactElement {
  const picker = useOptionalPluginUiPresentationHost()?.localDateTimePicker;
  return <HappierLocalDateTimeField {...props} theme={usePluginTheme()} {...(picker ? { picker } : {})} />;
}

export type ValidationMessageProps = Readonly<{ message: string; testID?: string }>;

export function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement {
  return <HappierValidationMessage message={message} theme={usePluginTheme()} testID={testID} />;
}

export type FormActionsProps = Readonly<{
  children?: ReactNode;
  /** Actions at the cluster's far edge, after the others: the irreversible one (Delete, Leave). */
  trailing?: ReactNode;
  /** One line under the actions: the consequence of the destructive action, or why it was refused. */
  footnote?: string | null;
  /** A key from this plugin's declared translation bundle; `footnote` is its fallback. */
  footnoteKey?: string;
  /** `danger` is a refusal, announced as it appears; `secondary` (default) a static consequence. */
  footnoteTone?: 'secondary' | 'danger';
  footnoteTestID?: string;
  testID?: string;
}>;

/**
 * A row of buttons at the end of a form or page section: Save and Cancel, or the quiet
 * leave-and-destroy actions that close a page, with an optional consequence or refusal line beneath.
 * Pending and submit state stay with the buttons and their caller.
 */
function FormActions({ children, trailing, footnote, footnoteKey, footnoteTone, footnoteTestID, testID }: FormActionsProps): ReactElement {
  const translate = usePluginTranslation();
  return (
    <HappierFormActions
      trailing={trailing}
      footnote={resolveAuthorText(translate, footnote ?? undefined, footnoteKey)}
      footnoteTone={footnoteTone}
      footnoteTestID={footnoteTestID}
      testID={testID}
    >
      {children}
    </HappierFormActions>
  );
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
  /** Prevent submission of an incomplete draft while keeping fields and Cancel usable. */
  submitDisabled?: boolean;
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
  // Defaults describe the opening draft. Later author replacements, including
  // clearing the form, stay authoritative rather than being seeded again.
  const [opening, setOpening] = useState<{ source: string; value: Record<string, unknown> } | null>(() => ({
    source: JSON.stringify(props.value),
    value: seedInputByFieldHints(spec, props.value),
  }));
  const useOpening = opening !== null && opening.source === JSON.stringify(props.value);
  if (opening !== null && !useOpening) setOpening(null);
  const value = useOpening ? opening.value : props.value;
  const fields = resolveEffectiveActionInputFields(spec, value);
  const submission = useHappierFormSubmission(props.busy);
  const formDisabled = props.disabled === true || submission.pending;
  const patch = (path: string, next: unknown) => props.onChange(writeHappierActionInputPath(value, path, next));
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
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
        const fieldValue = readHappierActionInputPath(value, field.path);
        return (
          <HappierInputField<FormOptionValue>
            key={field.path}
            field={field}
            value={fieldValue}
            selection={readActionInputSelectionForPresentation(field, fieldValue)}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
              ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
            }))}
            disabled={formDisabled}
            issue={props.issues?.[field.path]}
            isEqual={isSameActionInputOptionValue}
            keyForOption={(option) => actionInputOptionValueKey(option.value)}
            theme={theme}
            onChange={(next) => patch(field.path, next)}
          />
        );
      })}
      <FormActions>
        <Button
          title={submitLabel}
          busy={submission.pending}
          disabled={formDisabled || props.submitDisabled === true}
          onPress={() => submission.submit(() => props.onSubmit(
            normalizeActionInputByFieldHints(spec, { ...value }),
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
