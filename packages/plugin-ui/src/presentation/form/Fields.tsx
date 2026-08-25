import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Platform,
  TextInput as ReactNativeTextInput,
  View,
  type TextStyle,
} from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import {
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiLocalization,
} from '../../environment/context.js';
import {
  resolveHappierInteractiveTargetFloor,
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import { HappierLabel } from '../content/Foundation.js';
import {
  HappierItemGroupBehavior,
  useHappierItemGroupItemBehavior,
} from '../collection/ItemGroup.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type {
  HappierAccessibilityLiveRegion,
  HappierStyleProp,
  HappierTextSelection,
} from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { scaleTextStyleMetrics } from '../text/textStyleScale.js';
import { resolveHappierTextScaleOwnership } from '../text/textScaleOwnership.js';

function resolveMinimumTouchTarget(
  requested: number | undefined,
  nativeMinimum: number | undefined,
): number | undefined {
  return resolveHappierInteractiveTargetFloor(requested, nativeMinimum);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const valueType = typeof value;
  if (valueType !== 'object' && valueType !== 'function') return false;
  return typeof (value as Readonly<{ then?: unknown }>).then === 'function';
}

export type HappierFormPendingInput = Readonly<{
  /** Work declared by the form's lifecycle owner. */
  busy?: boolean;
  /** Work started by the public Form submit callback. */
  implicitPending?: boolean;
}>;

/**
 * The single semantic pending fact consumed by public and core Action forms.
 *
 * A caller that already owns submission passes `busy`; `FormRoot` additionally
 * supplies its returned-promise lifecycle. Consumers never choose between the
 * two facts, so editability, busy chrome, and cancellation cannot drift.
 */
export function resolveHappierFormPending({
  busy,
  implicitPending,
}: HappierFormPendingInput): boolean {
  return busy === true || implicitPending === true;
}

/**
 * Owns the promise lifecycle created by the public Form submit callback.
 *
 * Core forms retain their existing Action-form lifecycle owner and consume
 * {@link resolveHappierFormPending}; this hook exists only where the public
 * callback itself is the producer of the returned promise.
 */
export function useHappierFormSubmission(busy?: boolean): Readonly<{
  pending: boolean;
  submit: (operation: () => unknown) => void;
}> {
  const [implicitPending, setImplicitPending] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = useCallback((operation: () => unknown) => {
    if (busy === true || pendingRef.current) return;

    const result = operation();
    if (!isThenable(result)) return;

    pendingRef.current = true;
    setImplicitPending(true);
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      pendingRef.current = false;
      if (mountedRef.current) setImplicitPending(false);
    });
  }, [busy]);

  return {
    pending: resolveHappierFormPending({ busy, implicitPending }),
    submit,
  };
}

export type HappierFormProps = Readonly<{
  children?: ReactNode;
  accessibilityLabel?: string;
  /** The form lifecycle owner has pending work; this does not create one. */
  busy?: boolean;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** The structural owner for a bounded action form, without draft or submit authority. */
export function HappierForm({ children, accessibilityLabel, busy, testID, style }: HappierFormProps) {
  return (
    <View
      role="form"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={busy ? { busy: true } : undefined}
      aria-busy={busy || undefined}
      testID={testID}
      style={[{ width: '100%', minWidth: 0 }, style]}
    >
      {children}
    </View>
  );
}

export type HappierFormActionsProps = Readonly<{
  children?: ReactNode;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** A named action cluster that cannot acquire a second submit/pending lifecycle. */
export function HappierFormActions({ children, testID, style }: HappierFormActionsProps) {
  return (
    <View
      role="toolbar"
      testID={testID}
      style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, style]}
    >
      {children}
    </View>
  );
}

export type HappierValidationMessageProps = Readonly<{
  message: string;
  theme: HappierUiTheme;
  testID?: string;
  /** Stable identity for a control's web error-message relationship. */
  nativeID?: string;
  /** The host or enclosing field owns when feedback is announced. */
  accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
}>;

export function HappierValidationMessage({
  message,
  theme,
  testID,
  nativeID,
  accessibilityLiveRegion,
}: HappierValidationMessageProps) {
  return (
    <HappierText
      accessibilityRole="alert"
      accessibilityLiveRegion={accessibilityLiveRegion}
      nativeID={nativeID}
      testID={testID}
      style={{
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        fontWeight: theme.typography.caption.fontWeight as TextStyle['fontWeight'],
        color: theme.colors.danger,
      }}
    >
      {message}
    </HappierText>
  );
}

export type HappierFieldProps = Readonly<{
  label: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  issue?: string;
  children?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
  style?: HappierStyleProp;
}>;

type HappierFieldIssueSemantics = Readonly<{
  invalid: boolean;
  issueId?: string;
  issueHint?: string;
}>;

const HappierFieldIssueContext = createContext<HappierFieldIssueSemantics>({ invalid: false });

function useHappierFieldIssueSemantics(): HappierFieldIssueSemantics {
  return useContext(HappierFieldIssueContext);
}

export function HappierField(props: HappierFieldProps) {
  const generatedIssueId = useId();
  const issue = props.issue || undefined;
  const issueSemantics: HappierFieldIssueSemantics = {
    invalid: issue !== undefined,
    ...(issue === undefined ? {} : {
      issueId: `happier-field-issue-${generatedIssueId}`,
      issueHint: issue,
    }),
  };
  return (
    <HappierFieldIssueContext.Provider value={issueSemantics}>
      <View
        testID={props.testID}
        style={[{ gap: props.theme.spacing.xsmall, opacity: props.disabled ? 0.5 : 1 }, props.style]}
      >
        <HappierLabel theme={props.theme}>
          {props.label}{props.required ? ' *' : ''}
        </HappierLabel>
        {props.description ? (
          <HappierText style={{
            fontSize: props.theme.typography.caption.fontSize,
            lineHeight: props.theme.typography.caption.lineHeight,
            fontWeight: props.theme.typography.caption.fontWeight as TextStyle['fontWeight'],
            color: props.theme.colors.secondaryText,
          }}>
            {props.description}
          </HappierText>
        ) : null}
        {props.children}
        {issue ? (
          <HappierValidationMessage
            message={issue}
            nativeID={issueSemantics.issueId}
            theme={props.theme}
            accessibilityLiveRegion="polite"
          />
        ) : null}
      </View>
    </HappierFieldIssueContext.Provider>
  );
}

export type HappierTextFieldProps = Readonly<{
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  secure?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric';
  /**
   * Overrides the prose-entry capitalization this field derives from `secure`
   * and `keyboardType`. A query, an identifier or a code is not a sentence.
   */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  /** Overrides the derived autocorrection, which also silences spellchecking. */
  autoCorrect?: boolean;
  /**
   * The caret or range this field must show. A controlled field whose value is
   * rewritten between keystrokes otherwise lands the caret at the end of the
   * new value, which makes editing anywhere but the tail impossible.
   */
  selection?: HappierTextSelection;
  onSelectionChange?: (selection: HappierTextSelection) => void;
  /**
   * The field's own commit key. Composition-aware on every platform this
   * package ships to: an IME candidate confirmed with Enter settles the
   * composition instead of submitting a half-typed query.
   */
  onSubmitEditing?: () => void;
  /** Reports the platform IME lifecycle without exposing a host event. */
  onCompositionChange?: (isComposing: boolean) => void;
  /** Returns true when Escape was handled and must not reach an outer owner. */
  onEscape?: () => boolean;
  /** Additive host floor; the mounted environment's native target always wins. */
  minimumTouchTarget?: number;
  /** Private semantic focus binding supplied by the public TextField adapter; disabled fields report no target. */
  controlRef?: (instance: unknown | null) => void;
  theme: HappierUiTheme;
  testID?: string;
}>;

export function HappierTextField(props: HappierTextFieldProps) {
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const accessibility = useOptionalHappierUiAccessibility();
  const fieldIssue = useHappierFieldIssueSemantics();
  const minimumTouchTarget = resolveMinimumTouchTarget(
    props.minimumTouchTarget,
    nativeMinimumTouchTarget,
  );
  const scaleOwnership = resolveHappierTextScaleOwnership({
    ...(accessibility === null ? {} : { environmentTextScale: accessibility.textScale }),
  });
  const textStyle = scaleTextStyleMetrics({
    color: props.theme.colors.text,
    backgroundColor: props.theme.colors.surface,
    fontSize: props.theme.typography.body.fontSize,
    lineHeight: props.theme.typography.body.lineHeight,
  }, scaleOwnership.metricScale);
  const authorSelectionChange = props.onSelectionChange;
  const composingRef = useRef(false);
  const handleCompositionStart = useCallback(() => {
    if (composingRef.current) return;
    composingRef.current = true;
    props.onCompositionChange?.(true);
  }, [props.onCompositionChange]);
  const handleCompositionEnd = useCallback(() => {
    if (!composingRef.current) return;
    composingRef.current = false;
    props.onCompositionChange?.(false);
  }, [props.onCompositionChange]);
  const handleKeyPress = useCallback((event: Readonly<{
    key?: string;
    isComposing?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    nativeEvent?: Readonly<{ key?: string; isComposing?: boolean }>;
  }>) => {
    const key = event.key ?? event.nativeEvent?.key;
    const composing = event.isComposing ?? event.nativeEvent?.isComposing ?? composingRef.current;
    if (key !== 'Escape' || composing) return;
    if (props.onEscape?.() !== true) return;
    event.preventDefault?.();
    event.stopPropagation?.();
  }, [props.onEscape]);
  const handleChange = useCallback((event: Readonly<{
    nativeEvent: Readonly<{ text?: string; isComposing?: boolean }>;
  }>) => {
    const composing = event.nativeEvent.isComposing;
    if (typeof composing === 'boolean' && composing !== composingRef.current) {
      composingRef.current = composing;
      props.onCompositionChange?.(composing);
    }
    if (typeof event.nativeEvent.text === 'string') props.onChangeText(event.nativeEvent.text);
  }, [props.onChangeText, props.onCompositionChange]);
  const compositionTargetRef = useRef<Readonly<{
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  }> | null>(null);
  const setControlRef = useCallback((instance: unknown | null) => {
    const previous = compositionTargetRef.current;
    previous?.removeEventListener('compositionstart', handleCompositionStart);
    previous?.removeEventListener('compositionend', handleCompositionEnd);
    const candidate = instance && typeof instance === 'object'
      && 'addEventListener' in instance && 'removeEventListener' in instance
      ? instance as typeof compositionTargetRef.current
      : null;
    compositionTargetRef.current = candidate;
    candidate?.addEventListener('compositionstart', handleCompositionStart);
    candidate?.addEventListener('compositionend', handleCompositionEnd);
    props.controlRef?.(props.disabled === true ? null : instance);
  }, [handleCompositionEnd, handleCompositionStart, props.controlRef, props.disabled]);
  // React Native and React Native Web both report the caret inside the native
  // event; the portable selection is lifted out here so no caller has to know
  // the host event shape to keep a caret.
  const onSelectionChange = useCallback((event: Readonly<{
    nativeEvent: Readonly<{ selection?: HappierTextSelection }>;
  }>) => {
    const selection = event.nativeEvent.selection;
    if (selection) authorSelectionChange?.(selection);
  }, [authorSelectionChange]);
  return (
    <ReactNativeTextInput
      ref={setControlRef}
      accessibilityLabel={props.label}
      accessibilityHint={fieldIssue.issueHint}
      accessibilityState={props.disabled ? { disabled: true } : undefined}
      aria-required={props.required || undefined}
      aria-disabled={props.disabled || undefined}
      aria-invalid={fieldIssue.invalid || undefined}
      aria-errormessage={fieldIssue.issueId}
      value={props.value}
      onChange={handleChange as never}
      selection={props.selection}
      onSelectionChange={authorSelectionChange === undefined ? undefined : onSelectionChange}
      onSubmitEditing={props.onSubmitEditing}
      onKeyPress={handleKeyPress as never}
      placeholder={props.placeholder}
      placeholderTextColor={props.theme.colors.mutedText}
      editable={!props.disabled}
      secureTextEntry={props.secure}
      // The derived values remain the default; an author's declaration is the
      // only thing that can replace them, so a field the author says nothing
      // about keeps behaving exactly as it did.
      autoCapitalize={props.autoCapitalize ?? (props.secure || props.keyboardType === 'url' ? 'none' : 'sentences')}
      autoCorrect={props.autoCorrect ?? (!props.secure && props.keyboardType !== 'url')}
      multiline={props.multiline}
      keyboardType={props.keyboardType}
      allowFontScaling={scaleOwnership.allowHostFontScaling}
      testID={props.testID}
      {...({
        onCompositionStart: handleCompositionStart,
        onCompositionEnd: handleCompositionEnd,
      } as Record<string, unknown>)}
      style={{
        minWidth: minimumTouchTarget,
        minHeight: props.multiline ? Math.max(96, minimumTouchTarget ?? 0) : minimumTouchTarget,
        borderWidth: 1,
        borderColor: props.theme.colors.border,
        borderRadius: props.theme.radii.control,
        paddingHorizontal: props.theme.spacing.medium,
        paddingVertical: props.theme.spacing.small,
        ...textStyle,
        textAlignVertical: props.multiline ? 'top' : 'center',
      }}
    />
  );
}

export function HappierToggle(props: Readonly<{
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Additive host floor; the mounted environment's native target always wins. */
  minimumTouchTarget?: number;
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const fieldIssue = useHappierFieldIssueSemantics();
  const minimumTouchTarget = resolveMinimumTouchTarget(
    props.minimumTouchTarget,
    nativeMinimumTouchTarget,
  );
  return (
    <HappierPressable
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      accessibilityHint={fieldIssue.issueHint}
      invalid={fieldIssue.invalid}
      errorMessageId={fieldIssue.issueId}
      checked={props.value}
      disabled={props.disabled}
      onPress={() => props.onChange(!props.value)}
      testID={props.testID}
      style={(state) => ({
        minWidth: minimumTouchTarget,
        minHeight: minimumTouchTarget,
        alignSelf: 'flex-start',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: state.focused ? props.theme.colors.focus : 'transparent',
        borderRadius: props.theme.radii.pill,
      })}
    >
      <View
        style={{
          width: 48,
          height: 28,
          borderRadius: props.theme.radii.pill,
          padding: 3,
          justifyContent: 'center',
          backgroundColor: props.value ? props.theme.colors.accent : props.theme.colors.control,
          opacity: props.disabled ? 0.4 : 1,
        }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: props.theme.radii.pill,
            backgroundColor: props.value ? props.theme.colors.onAccent : props.theme.colors.secondaryText,
            alignSelf: props.value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
    </HappierPressable>
  );
}

export type HappierSelectOption<Value = string> = Readonly<{
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>;

type HappierSelectOptionControlProps<Value> = Readonly<{
  option: HappierSelectOption<Value>;
  selected: boolean;
  disabled: boolean | undefined;
  onPress: () => void;
  theme: HappierUiTheme;
  minimumTouchTarget: number | undefined;
  fieldIssue: ReturnType<typeof useHappierFieldIssueSemantics>;
  itemGroupRadioIndex?: number;
  accessibilityRole: 'checkbox' | 'radio';
}>;

function HappierSelectOptionControl<Value>(props: HappierSelectOptionControlProps<Value>) {
  const groupItem = useHappierItemGroupItemBehavior({
    role: props.accessibilityRole === 'radio' ? 'radio' : undefined,
    itemGroupRadioIndex: props.itemGroupRadioIndex,
    disabled: props.disabled,
  });
  const accessibilityLabel = props.option.accessibilityLabel
    ?? (props.option.description ? `${props.option.label}: ${props.option.description}` : props.option.label);
  const tabIndex = groupItem.grouped
    ? groupItem.tabStopIndex === props.itemGroupRadioIndex ? 0 : -1
    : undefined;

  return (
    <HappierPressable
      accessibilityRole={props.accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={props.fieldIssue.issueHint}
      invalid={props.fieldIssue.invalid}
      errorMessageId={props.fieldIssue.issueId}
      checked={props.selected}
      disabled={props.disabled}
      controlRef={groupItem.grouped ? groupItem.targetRef : undefined}
      tabIndex={tabIndex}
      onKeyDown={groupItem.grouped ? groupItem.onKeyDown : undefined}
      onPress={props.onPress}
      testID={props.option.testID}
      style={(state) => ({
        minWidth: props.minimumTouchTarget,
        minHeight: props.minimumTouchTarget,
        borderWidth: 1,
        borderColor: state.focused ? props.theme.colors.focus : (props.selected ? props.theme.colors.accent : props.theme.colors.border),
        borderRadius: props.theme.radii.control,
        paddingHorizontal: props.theme.spacing.medium,
        paddingVertical: props.theme.spacing.small,
        backgroundColor: props.selected ? props.theme.colors.elevatedSurface : props.theme.colors.surface,
        opacity: state.disabled ? 0.4 : state.pressed ? 0.75 : 1,
      })}
    >
      <HappierText style={{
        fontSize: props.theme.typography.label.fontSize,
        lineHeight: props.theme.typography.label.lineHeight,
        fontWeight: props.theme.typography.label.fontWeight as TextStyle['fontWeight'],
        color: props.theme.colors.text,
      }}>
        {props.option.label}
      </HappierText>
      {props.option.description ? (
        <HappierText style={{
          fontSize: props.theme.typography.caption.fontSize,
          lineHeight: props.theme.typography.caption.lineHeight,
          fontWeight: props.theme.typography.caption.fontWeight as TextStyle['fontWeight'],
          color: props.theme.colors.secondaryText,
        }}>
          {props.option.description}
        </HappierText>
      ) : null}
    </HappierPressable>
  );
}

function defaultHappierSelectOptionKey<Value>(option: HappierSelectOption<Value>, index: number): string {
  switch (typeof option.value) {
    case 'string':
    case 'number':
    case 'boolean':
      return `${typeof option.value}:${String(option.value)}`;
    default:
      // Object-shaped values have no intrinsic React key. The public Form
      // supplies a semantic key; this standalone fallback remains unique
      // instead of collapsing every bounded JSON value to `[object Object]`.
      return `index:${index}`;
  }
}

export function HappierSelect<Value = string>(props: Readonly<{
  label: string;
  options: readonly HappierSelectOption<Value>[];
  value: Value | readonly Value[] | undefined;
  multiple?: boolean;
  maxSelections?: number;
  /** A required multi-select keeps this many selected values available. */
  minimumSelections?: number;
  required?: boolean;
  onChange: (value: Value | readonly Value[]) => void;
  /** Declarative controls can carry bounded JSON values rather than strings. */
  isEqual?: (left: Value, right: Value) => boolean;
  /** Stable identity for values that are not themselves string keys. */
  keyForOption?: (option: HappierSelectOption<Value>, index: number) => string;
  /** Additive host floor; the mounted environment's native target always wins. */
  minimumTouchTarget?: number;
  disabled?: boolean;
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  const fieldIssue = useHappierFieldIssueSemantics();
  const localization = useOptionalHappierUiLocalization();
  const minimumTouchTarget = resolveMinimumTouchTarget(
    props.minimumTouchTarget,
    nativeMinimumTouchTarget,
  );
  const isEqual = props.isEqual ?? Object.is;
  const selected = props.multiple
    ? (Array.isArray(props.value) ? props.value : [])
    : (props.value === undefined ? [] : [props.value as Value]);
  const declaredMinimumSelections = typeof props.minimumSelections === 'number'
    && Number.isFinite(props.minimumSelections)
    ? Math.max(0, Math.floor(props.minimumSelections))
    : 0;
  const minimumSelections = props.multiple
    ? Math.max(props.required ? 1 : 0, declaredMinimumSelections)
    : 0;
  const declaredMaxSelections = props.maxSelections === undefined || !Number.isFinite(props.maxSelections)
    ? undefined
    : Math.max(0, Math.floor(props.maxSelections));
  const maximumSelections = declaredMaxSelections === undefined
    ? undefined
    : Math.max(minimumSelections, declaredMaxSelections);
  const usedKeys = new Set<string>();
  const options = props.options.map((option, index) => {
    const isSelected = selected.some((value) => isEqual(value, option.value));
    const selectionFloorReached = props.multiple
      && isSelected
      && selected.length <= minimumSelections;
    // At a selection cap, a newly pressed option replaces the oldest
    // retained selection below. Disabling it would make a required
    // max-one field impossible to change and would misreport that option
    // as unavailable to assistive technology.
    const selectionCeilingPreventsAddition = props.multiple
      && !isSelected
      && maximumSelections === 0;
    const disabled = props.disabled
      || option.disabled
      || selectionFloorReached
      || selectionCeilingPreventsAddition;
    const baseKey = props.keyForOption?.(option, index) ?? defaultHappierSelectOptionKey(option, index);
    const key = usedKeys.has(baseKey) ? `${baseKey}:duplicate:${index}` : baseKey;
    usedKeys.add(key);
    return (
      <HappierSelectOptionControl
        key={key}
        option={option}
        selected={isSelected}
        disabled={disabled}
        accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
        theme={props.theme}
        minimumTouchTarget={minimumTouchTarget}
        fieldIssue={fieldIssue}
        onPress={() => {
          if (!props.multiple) {
            props.onChange(option.value);
            return;
          }
          const nextSelection = isSelected
            ? selected.filter((value) => !isEqual(value, option.value))
            : [...selected, option.value];
          // SDK-ACTION-FORM's submit normalization retains the tail, so
          // interactive replacement and submitted draft use one stable
          // retention order without giving this presentation authority
          // over Action input normalization.
          props.onChange(maximumSelections === undefined
            ? nextSelection
            : nextSelection.slice(-maximumSelections));
        }}
      />
    );
  });
  const renderOptions = (children: ReactNode): ReactNode => (
    <View
      role={props.multiple ? 'group' : 'radiogroup'}
      accessibilityLabel={props.label}
      accessibilityHint={Platform.OS === 'web' || !props.required
        ? undefined
        : localization?.translate('happier.plugin-ui.form.required', 'Required') ?? 'Required'}
      aria-required={Platform.OS === 'web' && props.required ? true : undefined}
      testID={props.testID}
      style={{ gap: props.theme.spacing.small }}
    >
      {children}
    </View>
  );
  if (props.multiple) return <>{renderOptions(options)}</>;
  return (
    <HappierItemGroupBehavior
      accessibilityRole="radiogroup"
      accessibilityLabel={props.label}
      selectableItemCount={props.options.length}
      renderContent={renderOptions}
    >
      {options}
    </HappierItemGroupBehavior>
  );
}
