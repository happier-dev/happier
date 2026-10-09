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
} from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierFocusable } from '../portableTypes.js';
import {
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiLocalization,
  resolveHappierUiPalette,
  useOptionalHappierUiPalette,
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
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { settleHappierRaisedEdge } from '../layout/raisedEdge.js';
import type {
  HappierAccessibilityLiveRegion,
  HappierStyleProp,
  HappierTextSelection,
} from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { scaleTextStyleMetrics } from '../text/textStyleScale.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import { resolveHappierTextScaleOwnership } from '../text/textScaleOwnership.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { HappierSwitch, HappierSwitchNative } from './Switch.js';
import {
  HAPPIER_FIELD_TEXT_METRICS,
  HappierFieldTextBox,
  HappierSearchFieldBox,
  resolveHappierFieldTextInputMetrics,
  type HappierFieldBoxColors,
} from './FieldBox.js';
import type { HappierFieldKeyboardType } from './fieldValueDraft.js';

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
  const captionStyle = useHappierTypeRoleStyle('caption', theme);
  return (
    <HappierText
      accessibilityRole="alert"
      accessibilityLiveRegion={accessibilityLiveRegion}
      nativeID={nativeID}
      testID={testID}
      style={{ ...captionStyle, color: theme.colors.danger }}
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
  descriptionId?: string;
  descriptionHint?: string;
}>;

const HappierFieldIssueContext = createContext<HappierFieldIssueSemantics>({ invalid: false });

/**
 * Whether a control is rendered inside a {@link HappierField}, which already
 * draws the visible name. A standalone control draws its own instead, so a
 * name is on screen exactly once either way.
 */
const HappierFieldScopeContext = createContext(false);

export function useHappierIsWithinField(): boolean {
  return useContext(HappierFieldScopeContext);
}

function useHappierFieldIssueSemantics(): HappierFieldIssueSemantics {
  return useContext(HappierFieldIssueContext);
}

function combineAccessibilityHints(...hints: readonly (string | undefined)[]): string | undefined {
  const present = hints.filter((hint): hint is string => Boolean(hint));
  if (present.length === 0) return undefined;
  return present.reduce((combined, hint) => {
    if (combined === '') return hint;
    return /[.!?…:;]\s*$/u.test(combined) ? `${combined} ${hint}` : `${combined}. ${hint}`;
  }, '');
}

export function HappierField(props: HappierFieldProps) {
  const captionStyle = useHappierTypeRoleStyle('caption', props.theme);
  const generatedIssueId = useId();
  const generatedDescriptionId = useId();
  const issue = props.issue || undefined;
  const description = props.description || undefined;
  const issueSemantics: HappierFieldIssueSemantics = {
    invalid: issue !== undefined,
    ...(description === undefined ? {} : {
      descriptionId: `happier-field-description-${generatedDescriptionId}`,
      descriptionHint: description,
    }),
    ...(issue === undefined ? {} : {
      issueId: `happier-field-issue-${generatedIssueId}`,
      issueHint: issue,
    }),
  };
  return (
    <HappierFieldIssueContext.Provider value={issueSemantics}>
      <HappierFieldScopeContext.Provider value>
      <View
        testID={props.testID}
        style={[{ gap: props.theme.spacing.xsmall, opacity: props.disabled ? 0.5 : 1 }, props.style]}
      >
        <HappierLabel theme={props.theme}>
          {props.label}{props.required ? ' *' : ''}
        </HappierLabel>
        {description ? (
          <HappierText nativeID={issueSemantics.descriptionId} style={{
            ...captionStyle,
            color: props.theme.colors.secondaryText,
          }}>
            {description}
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
      </HappierFieldScopeContext.Provider>
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
  keyboardType?: 'default' | 'url' | 'numeric' | HappierFieldKeyboardType;
  /**
   * `well` (default): the form field well. `field`: the configuration page's
   * bordered field box (a row's control) — the same box Happier core's
   * `FieldTextInput` draws — in `fieldColors`, with `error` beneath it.
   */
  appearance?: 'well' | 'field' | 'search';
  fieldColors?: HappierFieldBoxColors & Readonly<{ errorColor: string }>;
  /** `field` only: the field's refusal, shown beneath the box and announced. */
  error?: string;
  /** Fires when focus leaves the field (a draft that commits on leaving). */
  onBlur?: () => void;
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
  controlRef?: (instance: HappierFocusable | null) => void;
  /**
   * A decorative glyph drawn inside the field's well before the text (the
   * List's search field uses it). It is hidden from assistive technology; the
   * field's name stays its `label`.
   */
  leading?: ReactNode;
  /**
   * Controls inside the well between the leading glyph and the text (a search field's filter tokens). They stay
   * reachable and named; the field's own name stays its `label`.
   */
  inline?: ReactNode;
  /** A decorative mark at the end of the well (the field's keyboard shortcut), hidden from assistive technology. */
  trailing?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
}>;

export function HappierTextField(props: HappierTextFieldProps) {
  const palette = useOptionalHappierUiPalette(props.theme);
  const searchInputRef = useRef<HappierFocusable | null>(null);
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
  const bodyStyle = useHappierTypeRoleStyle('body', props.theme);
  // A field is a well on the control surface, like the host's own inputs and
  // this package's control-appearance triggers. `border` is the outline of a
  // bounded *surface* and is transparent in the light theme, so a field that
  // relied on it for its edge rendered as bare text on the page.
  const textStyle = scaleTextStyleMetrics({
    color: props.theme.colors.text,
    backgroundColor: props.theme.colors.control,
    fontSize: bodyStyle.fontSize,
    lineHeight: bodyStyle.lineHeight,
    ...(bodyStyle.fontFamily === undefined ? {} : { fontFamily: bodyStyle.fontFamily }),
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
    const focusTarget = instance && typeof instance === 'object'
      && 'focus' in instance && typeof instance.focus === 'function'
      ? instance as HappierFocusable
      : null;
    searchInputRef.current = focusTarget;
    props.controlRef?.(props.disabled === true ? null : focusTarget);
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
  const fieldAppearance = props.appearance === 'field' && props.fieldColors !== undefined ? props.fieldColors : null;
  const fieldInvalid = fieldIssue.invalid || (fieldAppearance !== null && Boolean(props.error));
  const wellStyle = {
    minHeight: props.multiline ? Math.max(96, minimumTouchTarget ?? 0) : minimumTouchTarget,
    borderWidth: 1,
    borderColor: props.theme.colors.border,
    borderRadius: props.theme.radii.control,
    paddingHorizontal: props.theme.spacing.medium,
    paddingVertical: props.theme.spacing.small,
  } as const;
  const input = (
    <ReactNativeTextInput
      ref={setControlRef}
      accessibilityLabel={props.label}
      accessibilityHint={combineAccessibilityHints(fieldIssue.descriptionHint, fieldIssue.issueHint)}
      accessibilityState={props.disabled ? { disabled: true } : undefined}
      aria-required={props.required || undefined}
      aria-disabled={props.disabled || undefined}
      aria-invalid={fieldInvalid || undefined}
      aria-errormessage={fieldIssue.issueId}
      aria-describedby={fieldIssue.descriptionId}
      value={props.value}
      onChange={handleChange as never}
      selection={props.selection}
      onSelectionChange={authorSelectionChange === undefined ? undefined : onSelectionChange}
      onSubmitEditing={props.onSubmitEditing}
      onBlur={props.onBlur}
      onKeyPress={handleKeyPress as never}
      placeholder={props.placeholder}
      placeholderTextColor={fieldAppearance?.placeholderColor ?? props.theme.colors.mutedText}
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
      style={props.appearance === 'search' ? {
          ...textStyle, flex: 1, minWidth: 0, minHeight: 20, padding: 0, margin: 0, borderWidth: 0, backgroundColor: 'transparent',
        } : fieldAppearance !== null
        ? {
            ...resolveHappierFieldTextInputMetrics({
              multiline: props.multiline,
              nativeMinimumTargetSize: nativeMinimumTouchTarget,
            }),
            ...(bodyStyle.fontFamily === undefined ? {} : { fontFamily: bodyStyle.fontFamily }),
            color: fieldAppearance.valueColor,
            backgroundColor: 'transparent',
            borderWidth: 0,
          }
        : props.leading === undefined
        ? {
            minWidth: minimumTouchTarget,
            ...wellStyle,
            ...textStyle,
            textAlignVertical: props.multiline ? 'top' : 'center',
          }
        : {
            flex: 1,
            minWidth: 0,
            minHeight: minimumTouchTarget,
            padding: 0,
            borderWidth: 0,
            ...textStyle,
            backgroundColor: 'transparent',
            textAlignVertical: 'center',
          }}
    />
  );
  if (props.appearance === 'search') return (
    <HappierSearchFieldBox
      testID={props.testID}
      radius={palette?.searchFieldRadiusPx ?? props.theme.radii.control}
      minimumTargetSize={minimumTouchTarget}
      colors={{
        backgroundColor: palette?.fieldBackground ?? props.theme.colors.surface,
        borderColor: palette?.sheetBorder ?? props.theme.colors.border,
        edge: palette?.searchFieldEdge,
      }}
      onFocusInput={() => searchInputRef.current?.focus()}
      leading={props.leading}
    >
      {input}
    </HappierSearchFieldBox>
  );
  if (fieldAppearance !== null) {
    return (
      <HappierFieldTextBox
        multiline={props.multiline}
        colors={{
          borderColor: props.error ? fieldAppearance.errorColor : fieldAppearance.borderColor,
          backgroundColor: fieldAppearance.backgroundColor,
          edge: settleHappierRaisedEdge(fieldAppearance.edge, { invalid: Boolean(props.error) }),
        }}
        error={props.error ? (
          <HappierText
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID={props.testID ? `${props.testID}.error` : undefined}
            style={{
              fontSize: HAPPIER_FIELD_TEXT_METRICS.errorFontSizePx,
              lineHeight: HAPPIER_FIELD_TEXT_METRICS.errorLineHeightPx,
              color: fieldAppearance.errorColor,
            }}
          >
            {props.error}
          </HappierText>
        ) : undefined}
      >
        {input}
      </HappierFieldTextBox>
    );
  }
  if (props.leading === undefined) return input;
  return (
    <View
      style={{
        ...wellStyle,
        minWidth: minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: props.theme.spacing.small,
        backgroundColor: props.theme.colors.control,
      }}
    >
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {props.leading}
      </View>
      {props.inline}
      {input}
      {props.trailing === undefined ? null : (
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {props.trailing}
        </View>
      )}
    </View>
  );
}

/**
 * A form toggle: the shared switch Happier core's `Switch` renders — the drawn
 * {@link HappierSwitch} on web, the platform {@link HappierSwitchNative} on
 * iOS and Android — in the host's switch colours, carrying the enclosing
 * field's description and issue relationships.
 */
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
  const accessibility = useOptionalHappierUiAccessibility();
  // An explicit theme always resolves a palette; the fallback only satisfies the optional return.
  const palette = useOptionalHappierUiPalette(props.theme) ?? resolveHappierUiPalette(props.theme);
  const minimumTouchTarget = resolveMinimumTouchTarget(
    props.minimumTouchTarget,
    nativeMinimumTouchTarget,
  );
  // The platform switch where the platform has one to offer; the drawn switch everywhere else.
  const SwitchHost = Platform.OS === 'ios' || Platform.OS === 'android' ? HappierSwitchNative : HappierSwitch;
  return (
    <SwitchHost
      value={props.value}
      onValueChange={props.onChange}
      disabled={props.disabled}
      colors={{
        trackOn: palette.switchTrackOn,
        trackOff: palette.switchTrackOff,
        thumb: palette.switchThumb,
        focusRing: props.theme.colors.focus,
      }}
      accessibilityLabel={props.label}
      accessibilityHint={combineAccessibilityHints(fieldIssue.descriptionHint, fieldIssue.issueHint)}
      describedById={fieldIssue.descriptionId}
      invalid={fieldIssue.invalid}
      errorMessageId={fieldIssue.issueId}
      reducedMotion={accessibility?.reducedMotion === true}
      minimumTouchTarget={minimumTouchTarget}
      testID={props.testID}
    />
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
  controlRef?: (instance: HappierFocusable | null) => void;
}>;

function HappierSelectOptionControl<Value>(props: HappierSelectOptionControlProps<Value>) {
  const labelStyle = useHappierTypeRoleStyle('label', props.theme);
  const captionStyle = useHappierTypeRoleStyle('caption', props.theme);
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
  const registerTarget = useCallback((target: HappierFocusable | null) => {
    groupItem.grouped && groupItem.targetRef?.(target);
    props.controlRef?.(target);
  }, [groupItem.grouped, groupItem.targetRef, props.controlRef]);

  return (
    <HappierPressable
      accessibilityRole={props.accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={combineAccessibilityHints(
        props.fieldIssue.descriptionHint,
        props.fieldIssue.issueHint,
      )}
      describedById={props.fieldIssue.descriptionId}
      invalid={props.fieldIssue.invalid}
      errorMessageId={props.fieldIssue.issueId}
      checked={props.selected}
      disabled={props.disabled}
      controlRef={groupItem.grouped || props.controlRef !== undefined ? registerTarget : undefined}
      tabIndex={tabIndex}
      onKeyDown={groupItem.grouped ? groupItem.onKeyDown : undefined}
      onPress={props.onPress}
      testID={props.option.testID}
      style={(state) => ({
        minWidth: props.minimumTouchTarget,
        minHeight: props.minimumTouchTarget,
        borderWidth: 1,
        borderColor: props.selected ? props.theme.colors.accent : props.theme.colors.border,
        ...happierFocusRingStyle({ visible: state.focused, color: props.theme.colors.focus }),
        borderRadius: props.theme.radii.control,
        paddingHorizontal: props.theme.spacing.medium,
        paddingVertical: props.theme.spacing.small,
        backgroundColor: props.selected ? props.theme.colors.elevatedSurface : props.theme.colors.surface,
        opacity: state.disabled ? 0.4 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
      })}
    >
      <HappierText style={{ ...labelStyle, color: props.theme.colors.text }}>
        {props.option.label}
      </HappierText>
      {props.option.description ? (
        <HappierText style={{ ...captionStyle, color: props.theme.colors.secondaryText }}>
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

function retainLastSemanticSelections<Value>(
  values: readonly Value[],
  isEqual: (left: Value, right: Value) => boolean,
): Value[] {
  const retainedInReverseOrder: Value[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]!;
    if (!retainedInReverseOrder.some((retained) => isEqual(value, retained))) {
      retainedInReverseOrder.push(value);
    }
  }
  return retainedInReverseOrder.reverse();
}

export type HappierSelectPlanInput<Value, Option extends HappierSelectOption<Value> = HappierSelectOption<Value>> = Readonly<{
  options: readonly Option[];
  value: Value | readonly Value[] | undefined;
  multiple?: boolean;
  maxSelections?: number;
  minimumSelections?: number;
  required?: boolean;
  disabled?: boolean;
  isEqual?: (left: Value, right: Value) => boolean;
  keyForOption?: (option: Option, index: number) => string;
}>;

export type HappierSelectOptionPlan<Value, Option extends HappierSelectOption<Value> = HappierSelectOption<Value>> = Readonly<{
  option: Option;
  /** Stable, unique React/menu identity for this option. */
  key: string;
  selected: boolean;
  disabled: boolean;
  /** The whole next field value one press on this option produces. */
  nextValue: () => Value | readonly Value[];
}>;

/**
 * The one owner of Select's selection rules — identity, duplicate rejection,
 * the required/minimum floor, the maximum cap and tail retention — for every
 * presentation of a Select (inline option controls or a menu). A presentation
 * renders the plan; it never re-derives which option is selected, disabled or
 * what a press emits.
 */
export function planHappierSelectOptions<Value, Option extends HappierSelectOption<Value> = HappierSelectOption<Value>>(input: HappierSelectPlanInput<Value, Option>): Readonly<{
  selected: readonly Value[];
  options: readonly HappierSelectOptionPlan<Value, Option>[];
}> {
  const isEqual = input.isEqual ?? Object.is;
  const selected = input.multiple
    ? retainLastSemanticSelections(Array.isArray(input.value) ? input.value : [], isEqual)
    : (input.value === undefined ? [] : [input.value as Value]);
  // Option identity belongs to this shared Select owner. In particular, a
  // caller-provided canonical comparator must reject semantically duplicate
  // values before React keys or selection state can split them into two
  // controls. Key suffixes are only a rendering fallback for unrelated
  // options; they must never hide duplicate semantic choices.
  for (let index = 0; index < input.options.length; index += 1) {
    const option = input.options[index]!;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = input.options[previousIndex]!;
      if (isEqual(previous.value, option.value)) {
        throw new Error(`Select options contain duplicate values at indexes ${previousIndex} and ${index}.`);
      }
    }
  }
  const declaredMinimumSelections = typeof input.minimumSelections === 'number'
    && Number.isFinite(input.minimumSelections)
    ? Math.max(0, Math.floor(input.minimumSelections))
    : 0;
  const minimumSelections = input.multiple
    ? Math.max(input.required ? 1 : 0, declaredMinimumSelections)
    : 0;
  const declaredMaxSelections = input.maxSelections === undefined || !Number.isFinite(input.maxSelections)
    ? undefined
    : Math.max(0, Math.floor(input.maxSelections));
  const maximumSelections = declaredMaxSelections === undefined
    ? undefined
    : Math.max(minimumSelections, declaredMaxSelections);
  const usedKeys = new Set<string>();
  const options = input.options.map((option, index): HappierSelectOptionPlan<Value, Option> => {
    const isSelected = selected.some((value) => isEqual(value, option.value));
    const selectionFloorReached = input.multiple
      && isSelected
      && selected.length <= minimumSelections;
    // At a selection cap, a newly pressed option replaces the oldest
    // retained selection below. Disabling it would make a required
    // max-one field impossible to change and would misreport that option
    // as unavailable to assistive technology.
    const selectionCeilingPreventsAddition = input.multiple
      && !isSelected
      && maximumSelections === 0;
    const disabled = input.disabled === true
      || option.disabled === true
      || selectionFloorReached === true
      || selectionCeilingPreventsAddition === true;
    const baseKey = input.keyForOption?.(option, index) ?? defaultHappierSelectOptionKey(option, index);
    const key = usedKeys.has(baseKey) ? `${baseKey}:duplicate:${index}` : baseKey;
    usedKeys.add(key);
    return {
      option,
      key,
      selected: isSelected,
      disabled,
      nextValue: () => {
        if (!input.multiple) return option.value;
        const nextSelection = isSelected
          ? selected.filter((value) => !isEqual(value, option.value))
          : [...selected, option.value];
        // SDK-ACTION-FORM's submit normalization retains the tail, so
        // interactive replacement and submitted draft use one stable
        // retention order without giving this presentation authority
        // over Action input normalization.
        return maximumSelections === undefined
          ? nextSelection
          : maximumSelections === 0
            ? []
            : nextSelection.slice(-maximumSelections);
      },
    };
  });
  return { selected, options };
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
  /** Receives the field's first enabled physical option. */
  controlRef?: (instance: HappierFocusable | null) => void;
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
  const plan = planHappierSelectOptions(props);
  let focusTargetAssigned = false;
  const options = plan.options.map((entry) => {
    const controlRef = entry.disabled || focusTargetAssigned ? undefined : props.controlRef;
    if (!entry.disabled) focusTargetAssigned = true;
    return (
      <HappierSelectOptionControl
        key={entry.key}
        option={entry.option}
        selected={entry.selected}
        disabled={entry.disabled}
        accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
        theme={props.theme}
        minimumTouchTarget={minimumTouchTarget}
        fieldIssue={fieldIssue}
        controlRef={controlRef}
        onPress={() => { props.onChange(entry.nextValue()); }}
      />
    );
  });
  const renderOptions = (children: ReactNode): ReactNode => (
    <View
      role={props.multiple ? 'group' : 'radiogroup'}
      accessibilityLabel={props.label}
      accessibilityHint={Platform.OS === 'web'
        ? undefined
        : combineAccessibilityHints(
            fieldIssue.descriptionHint,
            props.required
              ? localization?.translate('happier.plugin-ui.form.required', 'Required') ?? 'Required'
              : undefined,
          )}
      aria-describedby={fieldIssue.descriptionId}
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
