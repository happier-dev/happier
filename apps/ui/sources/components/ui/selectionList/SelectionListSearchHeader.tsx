import * as React from 'react';
import { View, Platform, TextInput as RNTextInput, type NativeSyntheticEvent, type StyleProp, type TextInputKeyPressEventData, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextInput } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { SelectionListInputGhost } from './SelectionListInputGhost';
import { SelectionListInputMirror } from './SelectionListInputMirror';
import { SelectionListSearchHeaderLeadingSlot } from './SelectionListSearchHeaderLeadingSlot';
import { SelectionListStartEllipsisInputValue } from './SelectionListStartEllipsisInputValue';
import { selectionListTestId } from './_shared';
import type { SelectionListTextEllipsizeMode } from './_types';

const IS_WEB = Platform.OS === 'web';

/**
 * RUX-10 — Web-only TextStyle augmentation.
 *
 * `caretColor` is a CSS property RN-web forwards to the DOM verbatim but
 * which React Native's `TextStyle` type does not include. We narrow the
 * surface to the exact fields we set (color override + caretColor +
 * absolute positioning) rather than escaping to `any`.
 */
type WebOverlayInputStyle = Pick<TextStyle, 'color'> & Readonly<{
    position?: 'absolute';
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
    backgroundColor?: 'transparent';
    caretColor?: string;
}>;

type WebKeyDownTarget = Readonly<{
    addEventListener: (type: 'keydown', listener: (event: KeyboardEvent) => void) => void;
    removeEventListener: (type: 'keydown', listener: (event: KeyboardEvent) => void) => void;
}>;

function isWebKeyDownTarget(value: unknown): value is WebKeyDownTarget {
    return (
        typeof value === 'object'
        && value !== null
        && 'addEventListener' in value
        && typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
        && 'removeEventListener' in value
        && typeof (value as { removeEventListener?: unknown }).removeEventListener === 'function'
    );
}

function assignInputRef(ref: React.Ref<RNTextInput> | undefined, value: RNTextInput | null): void {
    if (!ref) return;
    if (typeof ref === 'function') {
        ref(value);
        return;
    }
    (ref as React.MutableRefObject<RNTextInput | null>).current = value;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    leadingSlot: {
        marginRight: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    /**
     * RUX-10: input-wrap is the row-level container that absorbs the
     * remaining horizontal space and lays out the input-cell + (legacy
     * native sibling ghost) in a row. On web the ghost is delivered via
     * the layered mirror INSIDE the cell, not as a sibling.
     */
    inputWrap: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 0,
    },
    /**
     * RUX-10: input-cell is the LAYERING container for the editable
     * TextInput + the visual mirror beneath it (web). On native (no
     * `caretColor` support) the cell only hosts the TextInput; the ghost is
     * rendered as a flex-row sibling next to the cell, preserving RUX-2's
     * behaviour for v1.
     *
     * `position: relative` anchors the absolutely-positioned TextInput
     * overlay on web. `overflow: hidden` clips the mirror identically to
     * the TextInput so long text never wraps to a second row.
     */
    inputCell: {
        flexShrink: 1,
        flexBasis: 'auto',
        // On web the cell must own its row height so the absolutely
        // positioned input has a non-zero box to fill. The line-height of
        // the mirror text drives the cell height naturally.
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.select({
            web: {
                position: 'relative',
                overflow: 'hidden',
                // Take the available width so the typed text + ghost have
                // room to extend; the suffix slot (browse button) is a
                // sibling of the wrap so it remains anchored to the right.
                flex: 1,
            },
            default: {},
        }) as object),
    },
    inputCellOverlay: {
        position: 'relative',
        overflow: 'hidden',
        flex: 1,
    },
    input: {
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        color: theme.colors.input.text,
        paddingVertical: 0,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
            },
            default: {},
        }) as object),
    },
    /**
     * RUX-10: native fallback — no mirror, ghost rendered as a flex
     * sibling. The input shrink-fits its content so the ghost sits flush
     * to the right of the typed text (the previous behaviour). On web this
     * shape is unused.
     */
    inputNativeShrinkFit: {
        flex: 0,
        flexShrink: 1,
        flexBasis: 'auto',
    },
    /**
     * RUX-10: web overlay — the editable TextInput floats above the mirror
     * with transparent text but a visible caret. The mirror underneath
     * paints the typed value + ghost suffix as inline `<Text>` spans.
     */
    inputOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        color: 'transparent',
        caretColor: theme.colors.input.text,
    } satisfies WebOverlayInputStyle,
    inputOverlayNative: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        color: 'transparent',
    } satisfies TextStyle,
    /**
     * RUX-10: when the ghost is absent the layered approach is overkill —
     * the TextInput renders as a normal opaque inline element again.
     */
    inputWebInline: {
        flex: 1,
    },
    inputSuffixSlot: {
        marginLeft: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export type SelectionListSearchHeaderProps = Readonly<{
    value: string;
    onChangeText: (next: string) => void;
    placeholder: string;
    /** True when the step stack has more than one entry — leading slot becomes a back chip. */
    canPop: boolean;
    /** Required when `canPop` is true. */
    backLabel?: string;
    onPopStep?: () => void;
    /** Optional overlay rendered to the right of the input (e.g. esc chip). */
    rightAdornment?: React.ReactNode;
    /** Override the reduced-motion preference (test/escape hatch). */
    reducedMotion?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /** Hook the underlying TextInput ref so the parent can imperatively focus. */
    inputRef?: React.Ref<RNTextInput>;
    /**
     * Key event handler. Web sends `KeyboardEvent`-like objects via rn-web's
     * `onKeyPress`; native sends `NativeSyntheticEvent<TextInputKeyPressEventData>`.
     * Modeled here as the union so consumers don't need to cast.
     */
    onKeyPress?: (
        event: NativeSyntheticEvent<TextInputKeyPressEventData> | {
            key?: string;
            isComposing?: boolean;
            metaKey?: boolean;
            ctrlKey?: boolean;
            shiftKey?: boolean;
            preventDefault?: () => void;
            stopPropagation?: () => void;
            nativeEvent?: TextInputKeyPressEventData & {
                isComposing?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                shiftKey?: boolean;
            };
        },
    ) => void;
    /** Phase 2.4: ghost suffix rendered after the input value. Empty = hidden. */
    ghostSuffix?: string;
    /** Optional visual truncation for value-like inputs such as paths. */
    inputValueEllipsizeMode?: SelectionListTextEllipsizeMode;
    /**
     * Phase 2.7: optional element inserted to the left of the input. When the
     * back chip is visible the prefix is suppressed (back chip wins the
     * leading slot).
     */
    inputPrefix?: React.ReactNode;
    /**
     * Phase 2.7: optional element inserted to the right of the input inside
     * the field (functional actions, e.g. tree-browser button).
     */
    inputSuffix?: React.ReactNode;
    /** Phase 2.7: caret-at-end tracking for keyboard nav. */
    onCaretAtEndChange?: (caretAtEnd: boolean) => void;
    /** Phase 2.7: IME composition status (web only). */
    onIsComposingChange?: (isComposing: boolean) => void;
    /** Phase 2.10: combobox role wiring (web). */
    listboxId?: string;
    activeDescendantId?: string;
}>;

/**
 * Persistent top bar for SelectionList. Renders one row:
 *   [leading slot]  [TextInput]  [rightAdornment?]
 *
 * The leading slot swaps between a search icon (when `canPop === false`) and a
 * back chip (when `canPop === true`). The swap uses a local `Animated.View`
 * cross-fade — NEVER `LayoutAnimation` (would animate unintended sibling
 * layouts and require Android opt-in).
 *
 * The TextInput element is not remounted across canPop swaps so focus survives
 * the leading-slot transition.
 */
export function SelectionListSearchHeader(props: SelectionListSearchHeaderProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;
    const inputNodeRef = React.useRef<RNTextInput | null>(null);
    const setInputNodeRef = React.useCallback((node: RNTextInput | null) => {
        inputNodeRef.current = node;
        assignInputRef(props.inputRef, node);
    }, [props.inputRef]);

    const showBack = props.canPop;
    const lastCaretAtEndRef = React.useRef<boolean | null>(null);
    const handleSelectionChange = React.useCallback(
        (event: { nativeEvent?: { selection?: { start: number; end: number } } }) => {
            const selection = event?.nativeEvent?.selection;
            if (!selection || !props.onCaretAtEndChange) return;
            const next =
                selection.start === props.value.length && selection.end === props.value.length;
            if (lastCaretAtEndRef.current === next) return;
            lastCaretAtEndRef.current = next;
            props.onCaretAtEndChange(next);
        },
        [props.onCaretAtEndChange, props.value.length],
    );
    const handleCompositionStart = React.useCallback(() => {
        props.onIsComposingChange?.(true);
    }, [props.onIsComposingChange]);
    const handleCompositionEnd = React.useCallback(() => {
        props.onIsComposingChange?.(false);
    }, [props.onIsComposingChange]);

    // Web combobox role wiring — per WAI-ARIA APG, the combobox role MUST live
    // on the focusable element (the input) so screen readers announce option
    // changes when `aria-activedescendant` updates. Putting it on the wrapper
    // would make the input itself a plain text field semantically. The wrapper
    // stays a generic container.
    const ghostSuffix = props.ghostSuffix ?? '';
    const hasGhost = ghostSuffix.length > 0;
    // RUX-10: the layered-mirror approach is web-only (depends on
    // `caretColor`). On native we keep RUX-2's sibling-ghost layout.
    const useLayeredMirror = IS_WEB && hasGhost;
    const useStartEllipsisValueMirror = props.inputValueEllipsizeMode === 'head'
        && props.value.length > 0
        && !useLayeredMirror;
    const useOverlayInput = useLayeredMirror || useStartEllipsisValueMirror;
    type WebComboboxAria = Readonly<{
        role: 'combobox';
        'aria-haspopup': 'listbox';
        'aria-expanded': true;
        'aria-controls'?: string;
        'aria-activedescendant'?: string;
    }>;
    const webComboboxAria: WebComboboxAria | null = IS_WEB
        ? {
            role: 'combobox',
            'aria-haspopup': 'listbox',
            'aria-expanded': true,
            ...(props.listboxId !== undefined ? { 'aria-controls': props.listboxId } : {}),
            ...(props.activeDescendantId !== undefined
                ? { 'aria-activedescendant': props.activeDescendantId }
                : {}),
        }
        : null;
    // Web must listen on keydown because Tab/Shift+Tab are focus-navigation
    // keys and do not reliably reach keypress before browser traversal.
    // React Native Web can filter DOM-only keyboard props on TextInput/View,
    // so bridge directly through the resolved input DOM node.
    const nativeKeyPress = IS_WEB ? undefined : props.onKeyPress;
    React.useEffect(() => {
        if (!IS_WEB || !props.onKeyPress) return undefined;
        const target = inputNodeRef.current;
        if (!isWebKeyDownTarget(target)) return undefined;
        type HeaderKeyboardEvent = Parameters<NonNullable<SelectionListSearchHeaderProps['onKeyPress']>>[0];
        const listener = (event: KeyboardEvent) => {
            const bridgedEvent: HeaderKeyboardEvent = {
                key: event.key,
                isComposing: event.isComposing,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                preventDefault: () => event.preventDefault(),
                stopPropagation: () => event.stopPropagation(),
                nativeEvent: {
                    key: event.key,
                    isComposing: event.isComposing,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                } as TextInputKeyPressEventData & {
                    isComposing?: boolean;
                    metaKey?: boolean;
                    ctrlKey?: boolean;
                    shiftKey?: boolean;
                },
            };
            props.onKeyPress?.(bridgedEvent);
        };
        target.addEventListener('keydown', listener);
        return () => {
            target.removeEventListener('keydown', listener);
        };
    }, [props.onKeyPress]);

    // RUX-10: select the input style based on layering mode. When the
    // layered mirror is active, the input floats above the mirror with
    // transparent text + caretColor. Otherwise the input is opaque inline
    // (web w/o ghost) or shrink-fit (native, ghost or not).
    let inputStyle: StyleProp<TextStyle>;
    if (useOverlayInput) {
        inputStyle = [
            styles.input,
            (IS_WEB ? styles.inputOverlay : styles.inputOverlayNative) as TextStyle,
        ];
    } else if (IS_WEB) {
        inputStyle = [styles.input, styles.inputWebInline];
    } else {
        inputStyle = [styles.input, styles.inputNativeShrinkFit];
    }

    return (
        <View
            testID={props.testID}
            style={[styles.container, props.style]}
        >
            <SelectionListSearchHeaderLeadingSlot
                rootTestID={props.testID}
                canPop={props.canPop}
                backLabel={props.backLabel}
                onPopStep={props.onPopStep}
                reducedMotion={reducedMotion}
            />
            {props.inputPrefix != null && !showBack ? (
                <View
                    testID={selectionListTestId(props.testID, 'input-prefix')}
                    style={styles.leadingSlot}
                >
                    {props.inputPrefix}
                </View>
            ) : null}
            {/*
              * RUX-10: input-wrap hosts the input-cell (layering container)
              * and — on native — the sibling ghost. The wrap absorbs the
              * remaining horizontal space; the suffix slot below stays a
              * sibling of the wrap so functional buttons (e.g. browse
              * folder) remain anchored to the far right of the header.
              */}
            <View
                testID={selectionListTestId(props.testID, 'input-wrap')}
                style={styles.inputWrap}
            >
                <View
                    testID={selectionListTestId(props.testID, 'input-cell')}
                    style={[styles.inputCell, useOverlayInput ? styles.inputCellOverlay : null]}
                >
                    {/*
                      * Mirror sits BEFORE the TextInput so the input paints
                      * on top (last-rendered = top in RN-web's z-order
                      * without explicit zIndex). The mirror handles the null
                      * case internally when ghostSuffix is empty.
                      */}
                    {useLayeredMirror ? (
                        <SelectionListInputMirror
                            testID={selectionListTestId(props.testID, 'input', 'mirror')}
                            value={props.value}
                            ghostSuffix={ghostSuffix}
                        />
                    ) : null}
                    {useStartEllipsisValueMirror ? (
                        <SelectionListStartEllipsisInputValue
                            testID={selectionListTestId(props.testID, 'input', 'start-ellipsis')}
                            value={props.value}
                        />
                    ) : null}
                    <TextInput
                        ref={setInputNodeRef}
                        testID={selectionListTestId(props.testID, 'input')}
                        style={inputStyle}
                        value={props.value}
                        onChangeText={props.onChangeText}
                        placeholder={props.placeholder}
                        placeholderTextColor={theme.colors.input.placeholder}
                        cursorColor={useOverlayInput ? theme.colors.input.text : undefined}
                        selectionColor={useOverlayInput ? theme.colors.input.text : undefined}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onKeyPress={nativeKeyPress}
                        onSelectionChange={handleSelectionChange as never}
                        // Web composition handlers + combobox ARIA are passed through
                        // RN-web to the underlying DOM input; not part of RN's typed
                        // TextInputProps. The combobox/aria-* attributes belong on the
                        // input element (per WAI-ARIA APG) — not on the wrapper.
                        {...({
                            onCompositionStart: handleCompositionStart,
                            onCompositionEnd: handleCompositionEnd,
                            ...(webComboboxAria ?? {}),
                        } as Record<string, unknown>)}
                    />
                </View>
                {/*
                  * RUX-10: native sibling ghost — only rendered when we are
                  * NOT using the layered mirror (i.e. native, or web w/o
                  * ghost). On web with ghost the mirror inside the cell
                  * provides the visual suffix.
                  */}
                {!useLayeredMirror && hasGhost ? (
                    <SelectionListInputGhost
                        testID={selectionListTestId(props.testID, 'input', 'ghost')}
                        inputValue={props.value}
                        ghostSuffix={ghostSuffix}
                    />
                ) : null}
            </View>
            {props.inputSuffix != null ? (
                <View
                    testID={selectionListTestId(props.testID, 'input-suffix')}
                    style={styles.inputSuffixSlot}
                >
                    {props.inputSuffix}
                </View>
            ) : null}
            {props.rightAdornment != null ? <View>{props.rightAdornment}</View> : null}
        </View>
    );
}
