import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform, View } from 'react-native';
import { actionInputOptionValueKey, readActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierSpinner, iconMatchedSpinnerSize } from '../feedback/Spinner.js';
import { HAPPIER_BUTTON_DISABLED_OPACITY, resolveHappierButtonChrome } from '../interaction/buttonChrome.js';
import { HappierPressable, type HappierPressableStyleState } from '../interaction/Pressable.js';
import { happierDiscretePressStyle, happierPressTransitionStyle } from '../interaction/pressFeedback.js';
import type { HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';

/** The part of a typed field a picker needs: which field, and which declared input type it holds. */
export type HappierInputPickerField = Readonly<{
  path: string;
  title: string;
  inputType?: Readonly<{ pluginId: string; localId: string }>;
}>;

/** One choice the field already shows, from the host's single options read. */
export type HappierInputPickerOption = Readonly<{
  value: unknown;
  label: string;
  description?: string;
  disabled?: boolean;
}>;

export type HappierInputPickerRequest = Readonly<{
  field: HappierInputPickerField;
  /** The field's current value; the picker starts from it and never changes it itself. */
  value: unknown;
  /** The choices the field shows now. The picker's answer is checked against the same list. */
  options?: readonly HappierInputPickerOption[];
  /** Aborted when the field goes away; the host then answers `cancelled`. */
  signal: AbortSignal;
}>;

/**
 * What a picker settles to. `selected` carries a value the host already checked with the same
 * schema and options an agent's value meets; `cancelled` changes nothing; `error` is a field error
 * in the reader's language.
 */
export type HappierInputPickerResult =
  | Readonly<{ status: 'selected'; value: unknown }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'error'; message: string }>;

export type HappierInputPickerAffordance = Readonly<{
  /** The control's visible label, in the reader's language. */
  label: string;
  /** Its accessible name when the visible label alone does not say which field it chooses for. */
  accessibilityLabel?: string;
}>;

/**
 * The host's custom-picker port. The host owns which pickers are admitted, mounting the
 * plugin's picker, its lifetime and validating the answer; a form only asks. A field whose
 * type is unknown, removed, replaced or declares no picker gets `null` and keeps its ordinary
 * control, so its saved value stays as it is.
 */
export type HappierInputPickerPort = Readonly<{
  describe: (field: HappierInputPickerField) => HappierInputPickerAffordance | null;
  pick: (request: HappierInputPickerRequest) => Promise<HappierInputPickerResult>;
}>;

const HappierInputPickerContext = createContext<HappierInputPickerPort | null>(null);

/** Installs the host's picker port for every typed field beneath it. Hosts provide it; authors do not. */
export function HappierInputPickerProvider(props: Readonly<{
  port: HappierInputPickerPort | null;
  children?: ReactNode;
}>): ReactElement {
  return <HappierInputPickerContext.Provider value={props.port}>{props.children}</HappierInputPickerContext.Provider>;
}

export function useHappierInputPickerPort(): HappierInputPickerPort | null {
  return useContext(HappierInputPickerContext);
}

export type HappierInputPickerState = Readonly<{
  /** Null when this field has no admitted picker; the field keeps its ordinary control. */
  affordance: HappierInputPickerAffordance | null;
  /** The last attempt's field error, cleared by the next attempt. */
  error: string | null;
  /** Opens the picker. Resolves once it settles; the field's value changes only on `selected`. */
  open: () => Promise<void>;
  /** The trigger's focus handle, so focus comes back to it when the picker closes. */
  controlRef: (instance: HappierFocusable | null) => void;
}>;

/**
 * One picker lifecycle for a typed field, shared by every form that renders one (Actions,
 * Workflows, widget setup and the public Form). It never writes on cancel or error, ignores an
 * answer that arrives after the field went away, and returns focus to the trigger.
 */
export function useHappierInputPicker(input: Readonly<{
  field: HappierInputPickerField;
  value: unknown;
  options?: readonly HappierInputPickerOption[];
  onSelect: (value: unknown) => void;
}>): HappierInputPickerState {
  const port = useHappierInputPickerPort();
  const affordance = port?.describe(input.field) ?? null;
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const currentValue = readActionInputOptionValue(input.value);
  // Authors may replace Form hints without replacing the host port. Compare the
  // bounded public values, not fresh field/option objects created during rendering.
  const contextKey = JSON.stringify([
    input.field.path, input.field.inputType?.pluginId, input.field.inputType?.localId,
    currentValue === undefined ? null : actionInputOptionValueKey(currentValue),
    input.options?.flatMap(option => {
      const value = readActionInputOptionValue(option.value);
      return value === undefined ? [] : [[actionInputOptionValueKey(value), option.label, option.description, option.disabled === true]];
    }),
  ]);
  const controlNode = useRef<HappierFocusable | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => {
    attempt.current?.abort();
    attempt.current = null;
  }, [port, contextKey]);
  const controlRef = useCallback((instance: HappierFocusable | null) => {
    // The pressable releases its handle while busy; keep the last live one for the return.
    if (instance !== null) controlNode.current = instance;
  }, []);
  const open = useCallback(async () => {
    if (port === null) return;
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setError(null);
    const { field, value, options } = latest.current;
    const result = await port.pick({ field, value, ...(options === undefined ? {} : { options }), signal: controller.signal })
      .catch((): HappierInputPickerResult => ({ status: 'cancelled' }));
    if (controller.signal.aborted || attempt.current !== controller) {
      if (mounted.current && attempt.current === null) restoreFocus(controlNode.current);
      return;
    }
    attempt.current = null;
    if (result.status === 'selected') latest.current.onSelect(result.value);
    else if (result.status === 'error') setError(result.message);
    restoreFocus(controlNode.current);
  }, [port]);
  return { affordance, error, open, controlRef };
}

/** Back to the trigger, unless the reader already moved focus somewhere else on purpose. */
function restoreFocus(node: HappierFocusable | null): void {
  if (node === null) return;
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
  }
  node.focus();
}

/**
 * The custom-picker affordance beneath a typed field: a quiet secondary control that stays the
 * same width while the picker is open and announces itself busy.
 */
export function HappierInputPickerButton(props: Readonly<{
  picker: HappierInputPickerState;
  theme: HappierUiTheme;
  disabled?: boolean;
  testID?: string;
}>): ReactElement | null {
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion ?? false;
  const labelStyle = useHappierTypeRoleStyle('label', props.theme);
  const affordance = props.picker.affordance;
  if (affordance === null) return null;
  const disabled = props.disabled === true;
  const { foreground } = resolveHappierButtonChrome({ theme: props.theme, variant: 'secondary', disabled, focused: false });
  const resolveStyle = (state: HappierPressableStyleState): HappierPortableStyle => ({
    ...resolveHappierButtonChrome({ theme: props.theme, variant: 'secondary', disabled, focused: state.focused }).style,
    alignSelf: 'flex-start',
    opacity: state.disabled && !state.busy ? HAPPIER_BUTTON_DISABLED_OPACITY : 1,
    ...happierDiscretePressStyle(state.pressed && !state.disabled, reducedMotion),
    ...happierPressTransitionStyle(state.pressed, ['transform', 'opacity'], reducedMotion),
  });
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityLabel={affordance.accessibilityLabel ?? affordance.label}
      disabled={disabled}
      onPress={props.picker.open}
      controlRef={props.picker.controlRef}
      style={resolveStyle}
    >
      {(state) => (
        <>
          {state.busy ? (
            <HappierSpinner
              size={iconMatchedSpinnerSize(props.theme.typography.label.fontSize)}
              color={foreground}
              testID={props.testID ? `${props.testID}-spinner` : undefined}
            />
          ) : null}
          <View style={state.busy ? { opacity: 0 } : undefined}>
            <HappierText style={{ ...labelStyle, color: foreground }}>{affordance.label}</HappierText>
          </View>
        </>
      )}
    </HappierPressable>
  );
}
