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

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const reanimated = createReanimatedModuleMock();
    const View = React.forwardRef<HTMLDivElement, Record<string, unknown>>(function ReanimatedView(props, ref) {
        const { children, style, ...rest } = props;
        return React.createElement('div', {
            ...domProps(rest),
            ref,
            style: flattenStyle(style),
        }, children as React.ReactNode);
    });
    return {
        ...reanimated,
        default: { ...reanimated.default, View },
        View,
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

// Compile/load the real component after the platform boundaries, outside the DOM interaction's
// timeout. A cold transform under shared-host load is not a failed keyboard bridge.
const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');

describe('SelectionListSearchHeader placeholder', () => {
    it('ends a placeholder too long for the field with an ellipsis instead of clipping it mid-word', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <SelectionListSearchHeader
                        value=""
                        onChangeText={() => {}}
                        placeholder="Search or run a command…"
                        canPop={false}
                        inputSuffix={<span>This Home</span>}
                        testID="hdr"
                    />,
                );
            });
            const input = container.querySelector<HTMLInputElement>('[data-testid="hdr:input"]');
            expect(input?.style.textOverflow).toBe('ellipsis');
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});

describe('SelectionListSearchHeader web keydown bridge', () => {
    it('dispatches Tab keydown through a DOM ref bridge when React Native Web filters keyboard props', async () => {
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
        const { SelectionList } = await import('../SelectionList');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onSelect = vi.fn();

        // The real orchestrator owns the composition (roving focus → key dispatcher →
        // key-press handler → header bridge); the test only drives DOM keydowns.
        const renderList = (inputValue: string, optionIds: ReadonlyArray<string>) => (
            <SelectionList
                rootStep={{
                    id: 'root',
                    inputPlaceholder: 'Search models',
                    disableInputFilter: true,
                    sections: [{
                        kind: 'static',
                        id: 'models',
                        options: optionIds.map((id) => ({ id, label: id })),
                    }],
                }}
                inputValue={inputValue}
                onChangeInputValue={() => {}}
                onSelect={onSelect}
                onRequestClose={() => {}}
                keyboardHintsEnabled={false}
                disableTransitions
                testID="search"
            />
        );
        const press = async (input: Element, init: KeyboardEventInit): Promise<KeyboardEvent> => {
            const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
            await act(async () => {
                input.dispatchEvent(event);
            });
            return event;
        };
        const selectedIds = () => onSelect.mock.calls.map((call) => call[0]);

        try {
            await act(async () => {
                root.render(renderList('filtered', ['filtered-row-a', 'filtered-row-b']));
            });

            const input = container.querySelector('[data-testid="search:header:input"]');
            expect(input).toBeInstanceOf(HTMLInputElement);

            expect((await press(input!, { key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(false);
            expect((await press(input!, { key: 'Tab', code: 'Tab', shiftKey: true })).defaultPrevented).toBe(false);
            expect(onSelect).not.toHaveBeenCalled();

            expect((await press(input!, { key: 'ArrowDown', code: 'ArrowDown' })).defaultPrevented).toBe(true);
            expect((await press(input!, { key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(true);
            expect(selectedIds()).toEqual(['filtered-row-b']);

            await act(async () => {
                root.render(renderList('refined', ['refined-row-a', 'refined-row-b']));
            });
            expect((await press(input!, { key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(false);
            expect(selectedIds()).toEqual(['filtered-row-b']);

            await press(input!, { key: 'ArrowDown', code: 'ArrowDown' });
            expect((await press(input!, { key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(true);
            // A refine that replaces every identity reseeds focus on the first new match (row A), since
            // the user has not aimed at a row in these results (keyboard-nav owner, 192a9a83fd: "the initial
            // match is the current first match, not an old index"); the fresh ArrowDown then moves to row B.
            expect(selectedIds()).toEqual(['filtered-row-b', 'refined-row-b']);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});

describe('SelectionList web focus ownership', () => {
    it('keeps DOM focus on the combobox input while aria-activedescendant moves between untabbable options', async () => {
        const { SelectionList } = await import('../SelectionList');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SelectionList
                        rootStep={{
                            id: 'root',
                            inputPlaceholder: 'Search commands',
                            sections: [{
                                kind: 'static',
                                id: 'commands',
                                options: [
                                    { id: 'first', label: 'First command' },
                                    { id: 'second', label: 'Second command' },
                                ],
                            }],
                        }}
                        onSelect={() => {}}
                        onRequestClose={() => {}}
                        autoFocusInputOnWeb
                        keyboardHintsEnabled={false}
                        disableTransitions
                        testID="focus-list"
                    />,
                );
            });

            const input = container.querySelector('[data-testid="focus-list:header:input"]');
            const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
            expect(input).toBeInstanceOf(HTMLInputElement);
            expect(options).toHaveLength(2);
            expect(document.activeElement).toBe(input);
            expect(options.map((option) => option.tabIndex)).toEqual([-1, -1]);
            expect(input?.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

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
            expect(document.activeElement).toBe(input);
            expect(options.map((option) => option.tabIndex)).toEqual([-1, -1]);
            expect(input?.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('retains a single roving DOM Tab stop when the list has no input', async () => {
        const { SelectionList } = await import('../SelectionList');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SelectionList
                        rootStep={{
                            id: 'root',
                            sections: [{
                                kind: 'static',
                                id: 'commands',
                                options: [
                                    { id: 'first', label: 'First command' },
                                    { id: 'second', label: 'Second command' },
                                ],
                            }],
                        }}
                        onSelect={() => {}}
                        onRequestClose={() => {}}
                        keyboardHintsEnabled={false}
                        disableTransitions
                        testID="headerless-list"
                    />,
                );
            });

            const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
            expect(options).toHaveLength(2);
            expect(options.map((option) => option.tabIndex)).toEqual([0, -1]);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
