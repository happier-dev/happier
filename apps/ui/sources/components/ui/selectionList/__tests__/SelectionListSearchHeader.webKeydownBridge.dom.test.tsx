/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((acc, entry) => ({ ...acc, ...(flattenStyle(entry) ?? {}) }), {});
    }
    if (typeof style === 'object') return style as React.CSSProperties;
    return undefined;
}

function domProps(props: Record<string, unknown>): Record<string, unknown> {
    const {
        accessibilityLabel: _accessibilityLabel,
        accessibilityRole: _accessibilityRole,
        accessibilityHint: _accessibilityHint,
        accessible: _accessible,
        autoCapitalize: _autoCapitalize,
        autoCorrect: _autoCorrect,
        hitSlop: _hitSlop,
        nativeID,
        pointerEvents,
        selectable: _selectable,
        testID,
        ...rest
    } = props;
    return {
        ...rest,
        ...(typeof nativeID === 'string' ? { id: nativeID } : {}),
        ...(typeof pointerEvents === 'string' ? { 'data-pointer-events': pointerEvents } : {}),
        ...(typeof testID === 'string' ? { 'data-testid': testID } : {}),
    };
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('span', domProps(props)),
}));

vi.mock('react-native-reanimated', () => {
    const View = React.forwardRef<HTMLDivElement, Record<string, unknown>>(function ReanimatedView(props, ref) {
        const { children, style, ...rest } = props;
        return React.createElement('div', {
            ...domProps(rest),
            ref,
            style: flattenStyle(style),
        }, children as React.ReactNode);
    });
    return {
        default: { View },
        useAnimatedStyle: (factory: () => unknown) => factory(),
        useSharedValue: (value: unknown) => ({ value }),
        withTiming: (value: unknown) => value,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef<HTMLDivElement, Record<string, unknown>>(function View(props, ref) {
        const {
            children,
            style,
            onKeyDown: _onKeyDown,
            onLayout: _onLayout,
            ...rest
        } = props;
        return React.createElement(
            'div',
            {
                ...domProps(rest),
                ref,
                style: flattenStyle(style),
            },
            children as React.ReactNode,
        );
    });
    const Text = React.forwardRef<HTMLSpanElement, Record<string, unknown>>(function Text(props, ref) {
        const { children, style, ...rest } = props;
        return React.createElement(
            'span',
            {
                ...domProps(rest),
                ref,
                style: flattenStyle(style),
            },
            children as React.ReactNode,
        );
    });
    const Pressable = React.forwardRef<HTMLButtonElement, Record<string, unknown>>(function Pressable(props, ref) {
        const { children, style, onPress, ...rest } = props;
        return React.createElement('button', {
            ...domProps(rest),
            ref,
            type: 'button',
            style: flattenStyle(style),
            onClick: typeof onPress === 'function' ? () => onPress({}) : undefined,
        }, children as React.ReactNode);
    });
    const TextInput = React.forwardRef<HTMLInputElement, Record<string, unknown>>(function TextInput(props, ref) {
        const {
            style,
            value,
            onChangeText,
            onKeyDown: _onKeyDown,
            onKeyPress: _onKeyPress,
            onSelectionChange: _onSelectionChange,
            placeholderTextColor: _placeholderTextColor,
            ...rest
        } = props;
        return React.createElement('input', {
            ...domProps(rest),
            ref,
            value: typeof value === 'string' ? value : '',
            style: flattenStyle(style),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                if (typeof onChangeText === 'function') onChangeText(event.currentTarget.value);
            },
        });
    });

    return createReactNativeWebMock({
        View,
        Text,
        TextInput,
        Pressable,
        Animated: { View },
        Platform: {
            OS: 'web',
            select: <T,>(values: { web?: T; ios?: T; default?: T }) =>
                values.web ?? values.default ?? values.ios,
        },
        StyleSheet: {
            absoluteFillObject: {},
            flatten: flattenStyle,
            create: (styles: unknown) => styles,
        },
    });
});

describe('SelectionListSearchHeader web keydown bridge', () => {
    it('dispatches Tab keydown through a DOM ref bridge when React Native Web filters keyboard props', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onKeyPress = vi.fn((event: { preventDefault?: () => void }) => {
            event.preventDefault?.();
        });

        try {
            await act(async () => {
                root.render(
                    <SelectionListSearchHeader
                        value=""
                        onChangeText={() => {}}
                        placeholder="Search branches"
                        canPop
                        backLabel="Worktrees"
                        onKeyPress={onKeyPress}
                        testID="hdr"
                    />,
                );
            });

            const input = container.querySelector('[data-testid="hdr:input"]');
            expect(input).toBeInstanceOf(HTMLInputElement);

            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            });
            input!.dispatchEvent(event);

            expect(onKeyPress).toHaveBeenCalledTimes(1);
            expect(onKeyPress).toHaveBeenCalledWith(expect.objectContaining({
                key: 'Tab',
                shiftKey: true,
            }));
            expect(event.defaultPrevented).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('preserves native DOM Tab traversal for a populated search until Arrow navigation focuses a row', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const { createSelectionListKeyPressHandler } = await import('../SelectionListKeyboardInput');
        const {
            useSelectionListKeyboardNav,
            useSelectionListRovingFocus,
        } = await import('../useSelectionListKeyboardNav');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onActivate = vi.fn();

        function Harness(props: Readonly<{
            inputValue: string;
            visibleOptionIds: ReadonlyArray<string>;
        }>): React.ReactElement {
            // The production composition (`SelectionList`): roving focus is
            // owned once and resolved BEFORE the key dispatcher, which reads it
            // at event time. The dispatcher never owns focus itself.
            const focus = useSelectionListRovingFocus({
                flatVisibleOptionIds: props.visibleOptionIds,
                inputValue: props.inputValue,
                inputMode: 'search',
            });
            const keyboard = useSelectionListKeyboardNav({
                focus,
                flatVisibleOptionIds: props.visibleOptionIds,
                onActivate,
                canPopStep: false,
                onPopStep: () => {},
                inputValue: props.inputValue,
                onClearInput: () => {},
                inputMode: 'search',
                ghostSuffixPresent: false,
            });
            const focusedOptionId = focus.focusedOptionId;
            const handleKeyPress = React.useMemo(
                () => createSelectionListKeyPressHandler({
                    keyboard,
                    isComposing: false,
                    focusedOptionId,
                    onActivate,
                    canPopStep: false,
                    inputValue: props.inputValue,
                    onRequestClose: () => {},
                }),
                [keyboard, focusedOptionId, props.inputValue],
            );
            return (
                <SelectionListSearchHeader
                    value={props.inputValue}
                    onChangeText={() => {}}
                    placeholder="Search models"
                    canPop={false}
                    onKeyPress={handleKeyPress}
                    testID="search"
                />
            );
        }

        try {
            await act(async () => {
                root.render(
                    <Harness
                        inputValue="filtered"
                        visibleOptionIds={['filtered-row-a', 'filtered-row-b']}
                    />,
                );
            });

            const input = container.querySelector('[data-testid="search:input"]');
            expect(input).toBeInstanceOf(HTMLInputElement);

            const initialTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(initialTab);
            });
            expect(initialTab.defaultPrevented).toBe(false);
            expect(onActivate).not.toHaveBeenCalled();

            const initialShiftTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(initialShiftTab);
            });
            expect(initialShiftTab.defaultPrevented).toBe(false);
            expect(onActivate).not.toHaveBeenCalled();

            const arrowDown = new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                code: 'ArrowDown',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(arrowDown);
            });
            expect(arrowDown.defaultPrevented).toBe(true);

            const explicitTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(explicitTab);
            });
            expect(explicitTab.defaultPrevented).toBe(true);
            expect(onActivate).toHaveBeenCalledOnce();
            expect(onActivate).toHaveBeenCalledWith('filtered-row-b');

            await act(async () => {
                root.render(
                    <Harness
                        inputValue="refined"
                        visibleOptionIds={['refined-row-a', 'refined-row-b']}
                    />,
                );
            });
            const postFilterTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(postFilterTab);
            });
            expect(postFilterTab.defaultPrevented).toBe(false);
            expect(onActivate).toHaveBeenCalledOnce();

            const refinedArrowDown = new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                code: 'ArrowDown',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(refinedArrowDown);
            });
            const refinedExplicitTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            await act(async () => {
                input!.dispatchEvent(refinedExplicitTab);
            });
            expect(refinedExplicitTab.defaultPrevented).toBe(true);
            expect(onActivate).toHaveBeenCalledTimes(2);
            expect(onActivate).toHaveBeenLastCalledWith('refined-row-b');
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
