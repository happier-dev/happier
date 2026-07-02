import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';
import type { MultiTextInputHandle as NativeMultiTextInputHandle } from './MultiTextInput';
import type { MultiTextInputHandle as WebMultiTextInputHandle } from './MultiTextInput.web';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from './largeTextInputPolicy';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingState = vi.hoisted(() => ({
    uiFontScale: 1,
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiFontScale') return localSettingState.uiFontScale;
        return undefined;
    },
}));

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: 'View',
            TextInput: (props: any) => React.createElement('TextInput', props, null),
        });
    },
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({
            ...merged,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('MultiTextInput', () => {
    afterEach(() => {
        localSettingState.uiFontScale = 1;
    });

    it('forwards testID to the TextInput', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<MultiTextInput
                    testID="composer-input"
                    value=""
                    onChangeText={() => {}}
                />)).tree;
        const input = tree.findByType('TextInput' as any);
        expect(input.props.testID).toBe('composer-input');
    });

    it('uses the caller textStyle font size as the scaled native input base', async () => {
        localSettingState.uiFontScale = 1.25;

        const { MultiTextInput } = await import('./MultiTextInput');
        const tree = (await renderScreen(<MultiTextInput
                    testID="composer-input"
                    value=""
                    textStyle={{ fontSize: 16 }}
                    onChangeText={() => {}}
                />)).tree;
        const input = tree.findByType('TextInput' as any);
        expect(flattenStyle(input.props.style).fontSize).toBe(20);
    });

    it('derives the native return key type from submit behavior', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const submitTree = (await renderScreen(<MultiTextInput
                    testID="composer-input-submit"
                    value=""
                    submitBehavior="submit"
                    onChangeText={() => {}}
                />)).tree;
        const newlineTree = (await renderScreen(<MultiTextInput
                    testID="composer-input-newline"
                    value=""
                    submitBehavior="newline"
                    onChangeText={() => {}}
                />)).tree;

        expect(submitTree.findByType('TextInput' as any).props.returnKeyType).toBe('send');
        expect(newlineTree.findByType('TextInput' as any).props.returnKeyType).toBe('default');
    });

    it('keeps Android landscape editing inside the app surface', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const tree = (await renderScreen(<MultiTextInput
                    testID="composer-input"
                    value=""
                    onChangeText={() => {}}
                />)).tree;

        expect(tree.findByType('TextInput' as any).props.disableFullscreenUI).toBe(true);
    });

    it('lets native multiline input own wrapped-text measurement without a fixed JS height', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value={'a'.repeat(180)}
            maxHeight={144}
            paddingTop={8}
            paddingBottom={8}
            onChangeText={() => {}}
        />);

        const input = screen.tree.findByType('TextInput' as any);
        const style = flattenStyle(input.props.style);
        expect(style.height).toBeUndefined();
        expect(typeof style.minHeight).toBe('number');
        expect(style.maxHeight).toBe(144);
        expect(input.props.scrollEnabled).toBe(true);
    });

    it('keeps native autogrow as the layout owner after content-size reports', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn();
        const screen = await renderScreen(
            <MultiTextInput
                testID="composer-input"
                value={'line\n'.repeat(20)}
                maxHeight={144}
                onChangeText={() => {}}
                onContentHeightChange={onContentHeightChange}
            />,
        );

        const inputBeforeMeasure = screen.tree.findByType('TextInput' as any);
        expect(inputBeforeMeasure.props.onContentSizeChange).toEqual(expect.any(Function));

        await act(async () => {
            inputBeforeMeasure.props.onContentSizeChange({
                nativeEvent: { contentSize: { height: 260 } },
            });
        });

        const inputAfterMeasure = screen.tree.findByType('TextInput' as any);
        expect(flattenStyle(inputAfterMeasure.props.style).height).toBeUndefined();
        expect(flattenStyle(inputAfterMeasure.props.style).maxHeight).toBe(144);
        expect(inputAfterMeasure.props.scrollEnabled).toBe(true);
        expect(onContentHeightChange).toHaveBeenCalledWith(260);
    });

    it('does not report estimated native content height before native measurement', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn();

        await renderScreen(<MultiTextInput
            testID="composer-input"
            value={'line\nline\nline'}
            maxHeight={144}
            paddingTop={8}
            paddingBottom={8}
            onChangeText={() => {}}
            onContentHeightChange={onContentHeightChange}
        />);

        expect(onContentHeightChange).not.toHaveBeenCalled();
    });

    it('dedupes native content height reports before notifying callers', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn();
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value="line"
            maxHeight={144}
            onChangeText={() => {}}
            onContentHeightChange={onContentHeightChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onContentSizeChange({
                nativeEvent: { contentSize: { height: 88 } },
            });
            input.props.onContentSizeChange({
                nativeEvent: { contentSize: { height: 88 } },
            });
        });

        expect(onContentHeightChange).toHaveBeenCalledTimes(1);
        expect(onContentHeightChange).toHaveBeenCalledWith(88);
    });

    it('forwards testID as data-testid on web textarea', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: '',
                    onChangeText: () => {},
                }))).tree;
        const input = tree.findByType('textarea' as any);
        expect(input.props['data-testid']).toBe('composer-input');
    });

    it('uses the caller textStyle font size as the scaled web textarea base', async () => {
        localSettingState.uiFontScale = 1.25;

        const { MultiTextInput } = await import('./MultiTextInput.web');
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: '',
                    textStyle: { fontSize: 16 },
                    onChangeText: () => {},
        }))).tree;
        const input = tree.findByType('textarea' as any);
        expect(input.props.style.fontSize).toBe('20px');
        expect(input.props.style.color).toBeDefined();
        expect(input.props.style.fontFamily).toBeDefined();
    });

    it('uses one stable web textarea surface for short and very large values', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const shortTree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input-short',
            value: 'line\n'.repeat(2),
            maxHeight: 144,
            onChangeText: () => {},
        }))).tree;
        const largeTree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input-large',
            value: 'x'.repeat(60_000),
            maxHeight: 144,
            onChangeText: () => {},
        }))).tree;

        expect(() => shortTree.findByType('TextareaAutosize' as any)).toThrow();
        expect(shortTree.findByType('textarea' as any).props['data-testid']).toBe('composer-input-short');
        expect(() => largeTree.findByType('TextareaAutosize' as any)).toThrow();
        const largeInput = largeTree.findByType('textarea' as any);
        expect(largeInput.props['data-testid']).toBe('composer-input-large');
        expect(largeInput.props.style.maxHeight).toBe(144);
        expect(largeInput.props.style.overflowY).toBe('auto');
    });

    it('keeps oversized web textarea text visible and natively scrollable', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const largeValue = `${'a'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)}tail`;
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input-large',
            value: largeValue,
            maxHeight: 144,
            onChangeText: () => {},
        }))).tree;

        const input = tree.findByType('textarea' as any);
        expect(input.props.defaultValue).toBe(largeValue);
        expect(input.props.style.fontSize).not.toBe('0px');
        expect(input.props.style.lineHeight).not.toBe('0px');
        expect(input.props.style.color).not.toBe('transparent');
        expect(input.props.style.overflowY).toBe('auto');
        expect(() => tree.findByProps({ 'data-testid': 'composer-input-large-value-preview' })).toThrow();
    });

    it('does not collapse textarea paint before an oversized text paste reaches the DOM when attachments are unavailable', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'start',
            onChangeText: () => {},
        }))).tree;
        const input = tree.findByType('textarea' as any);
        const preventDefault = vi.fn();
        const currentTarget = {
            value: 'start',
            selectionStart: 5,
            selectionEnd: 5,
            style: {} as Record<string, string>,
        };

        input.props.onPaste({
            currentTarget,
            preventDefault,
            clipboardData: {
                items: [],
                files: [],
                getData: (type: string) => type === 'text/plain'
                    ? 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)
                    : '',
            },
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(currentTarget.style.fontSize).toBeUndefined();
        expect(currentTarget.style.lineHeight).toBeUndefined();
        expect(currentTarget.style.color).toBeUndefined();
    });

    it('keeps oversized web text pastes editable even when attachments are available', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onFilesPasted = vi.fn();
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'start',
            onChangeText: () => {},
            onFilesPasted,
        }))).tree;
        const input = tree.findByType('textarea' as any);
        const preventDefault = vi.fn();
        const currentTarget = {
            value: 'start',
            selectionStart: 5,
            selectionEnd: 5,
            style: {} as Record<string, string>,
        };
        const pastedText = '<html>'.repeat(Math.ceil((TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1) / 6));

        input.props.onPaste({
            currentTarget,
            preventDefault,
            clipboardData: {
                items: [],
                files: [],
                getData: (type: string) => type === 'text/plain' ? pastedText : '',
            },
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(onFilesPasted).not.toHaveBeenCalled();
        expect(currentTarget.style.fontSize).toBeUndefined();
        expect(currentTarget.style.lineHeight).toBeUndefined();
        expect(currentTarget.style.color).toBeUndefined();
    });

    it('defers oversized web text changes until the live text is flushed', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const ref = React.createRef<WebMultiTextInputHandle & { flushPendingTextChange?: () => string }>();
        const onChangeText = vi.fn();
        const onStateChange = vi.fn();
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            ref,
            testID: 'composer-input',
            value: '',
            onChangeText,
            onStateChange,
        }))).tree;
        const input = tree.findByType('textarea' as any);
        const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        const currentTarget = {
            value: largeText,
            selectionStart: largeText.length,
            selectionEnd: largeText.length,
            scrollHeight: 120,
            style: {} as Record<string, string>,
        };

        await act(async () => {
            input.props.onChange({
                target: currentTarget,
                currentTarget,
            });
        });

        expect(onChangeText).not.toHaveBeenCalled();
        expect(onStateChange).toHaveBeenCalledWith({
            text: largeText,
            selection: { start: largeText.length, end: largeText.length },
        });
        expect(typeof ref.current?.flushPendingTextChange).toBe('function');

        const flushed = ref.current?.flushPendingTextChange?.();

        expect(flushed).toBe(largeText);
        expect(onChangeText).toHaveBeenCalledWith(largeText);
    });

    it('drops pending oversized web text changes on unmount instead of emitting stale text', async () => {
        vi.useFakeTimers();
        try {
            const { MultiTextInput } = await import('./MultiTextInput.web');
            const onChangeText = vi.fn();
            const screen = await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                testID: 'composer-input',
                value: '',
                onChangeText,
            }));
            const input = screen.tree.findByType('textarea' as any);
            const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
            const currentTarget = {
                value: largeText,
                selectionStart: largeText.length,
                selectionEnd: largeText.length,
                scrollHeight: 120,
                style: {} as Record<string, string>,
            };

            await act(async () => {
                input.props.onChange({
                    target: currentTarget,
                    currentTarget,
                });
            });
            expect(onChangeText).not.toHaveBeenCalled();

            await act(async () => {
                screen.tree.unmount();
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
            });

            expect(onChangeText).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards native key event metadata used by composer shortcuts', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onKeyPress = vi.fn(() => true);
        const preventDefault = vi.fn();

        const tree = (await renderScreen(<MultiTextInput
            testID="composer-input"
            value="hello"
            onChangeText={() => {}}
            onKeyPress={onKeyPress}
        />)).tree;
        const input = tree.findByType('TextInput' as any);

        input.props.onSelectionChange({
            nativeEvent: {
                selection: { start: 1, end: 4 },
            },
        });

        input.props.onKeyPress({
            preventDefault,
            nativeEvent: {
                key: 'Enter',
                code: 'Enter',
                shiftKey: true,
                altKey: true,
                ctrlKey: true,
                metaKey: false,
                repeat: true,
                isComposing: false,
            },
        });

        expect(onKeyPress).toHaveBeenCalledWith({
            key: 'Enter',
            code: 'Enter',
            shiftKey: true,
            altKey: true,
            ctrlKey: true,
            metaKey: false,
            repeat: true,
            isComposing: false,
            inputState: {
                text: 'hello',
                selection: { start: 1, end: 4 },
            },
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it('restores native selection through the handle without changing text', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onChangeText = vi.fn();
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const ref = React.createRef<NativeMultiTextInputHandle>();

        await renderScreen(<MultiTextInput
            ref={ref}
            testID="composer-input"
            value="hello"
            onChangeText={onChangeText}
            onSelectionChange={onSelectionChange}
            onStateChange={onStateChange}
        />);

        await act(async () => {
            ref.current?.setSelection({ start: 2, end: 2 });
        });

        expect(onChangeText).not.toHaveBeenCalled();
        expect(onSelectionChange).toHaveBeenCalledWith({ start: 2, end: 2 });
        expect(onStateChange).toHaveBeenCalledWith({
            text: 'hello',
            selection: { start: 2, end: 2 },
        });
    });

    it('does not restore native selection while native text is ahead of the controlled value', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onChangeText = vi.fn();
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const ref = React.createRef<NativeMultiTextInputHandle>();

        const screen = await renderScreen(<MultiTextInput
            ref={ref}
            testID="composer-input"
            value="hello"
            onChangeText={onChangeText}
            onSelectionChange={onSelectionChange}
            onStateChange={onStateChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onChangeText('hello composing');
        });
        onSelectionChange.mockClear();
        onStateChange.mockClear();

        await act(async () => {
            ref.current?.setSelection({ start: 3, end: 3 });
        });

        expect(onSelectionChange).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
    });

    it('forwards web key event metadata used by composer shortcuts', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onKeyPress = vi.fn(() => true);
        const preventDefault = vi.fn();

        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: '',
            onChangeText: () => {},
            onKeyPress,
        }))).tree;
        const input = tree.findByType('textarea' as any);

        input.props.onKeyDown({
            key: 'Enter',
            code: 'Enter',
            shiftKey: false,
            altKey: true,
            ctrlKey: false,
            metaKey: true,
            repeat: true,
            keyCode: 13,
            nativeEvent: { isComposing: false },
            currentTarget: {
                value: 'draft',
                selectionStart: 2,
                selectionEnd: 2,
            },
            preventDefault,
        });

        expect(onKeyPress).toHaveBeenCalledWith({
            key: 'Enter',
            code: 'Enter',
            shiftKey: false,
            altKey: true,
            ctrlKey: false,
            metaKey: true,
            repeat: true,
            isComposing: false,
            inputState: {
                text: 'draft',
                selection: { start: 2, end: 2 },
            },
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it('reports web textarea scroll position changes', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onScrollYChange = vi.fn();

        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'line\n'.repeat(20),
            onChangeText: () => {},
            onScrollYChange,
        }))).tree;
        const input = tree.findByType('textarea' as any);

        expect(input.props.onScroll).toEqual(expect.any(Function));
        input.props.onScroll({
            currentTarget: {
                scrollTop: 42,
            },
        });

        expect(onScrollYChange).toHaveBeenCalledWith(42);
    });

    it('does not restore web scroll while IME composition is active', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const mockTextarea = {
            value: 'hello',
            scrollTop: 0,
            scrollHeight: 30,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: 'hello',
                    onChangeText: () => {},
                    initialScrollY: 12,
                }),
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });
        expect(mockTextarea.scrollTop).toBe(12);

        const input = tree!.root.findByType('textarea' as any);
        await act(async () => {
            input.props.onCompositionStart();
        });
        mockTextarea.scrollTop = 0;

        await act(async () => {
            tree!.update(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                testID: 'composer-input',
                value: 'hello updated',
                onChangeText: () => {},
                initialScrollY: 24,
            }));
        });

        expect(mockTextarea.scrollTop).toBe(0);
    });

    it('does not reapply web scroll restore on controlled value changes without a new restore token', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const mockTextarea = {
            value: 'hello',
            scrollTop: 0,
            scrollHeight: 30,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: 'hello',
                    onChangeText: () => {},
                    initialScrollY: 12,
                    scrollRestoreToken: 'session:s1:v1',
                }),
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });
        expect(mockTextarea.scrollTop).toBe(12);

        mockTextarea.scrollTop = 5;
        await act(async () => {
            tree!.update(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                testID: 'composer-input',
                value: 'hello updated by typing',
                onChangeText: () => {},
                initialScrollY: 12,
                scrollRestoreToken: 'session:s1:v1',
            }));
        });

        expect(mockTextarea.scrollTop).toBe(5);
    });

    it('reapplies web scroll restore when the restore token changes', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const mockTextarea = {
            value: 'hello',
            scrollTop: 0,
            scrollHeight: 30,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: 'hello',
                    onChangeText: () => {},
                    initialScrollY: 12,
                    scrollRestoreToken: 'session:s1:v1',
                }),
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });
        expect(mockTextarea.scrollTop).toBe(12);

        mockTextarea.scrollTop = 5;
        await act(async () => {
            tree!.update(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                testID: 'composer-input',
                value: 'hello',
                onChangeText: () => {},
                initialScrollY: 12,
                scrollRestoreToken: 'session:s2:v1',
            }));
        });

        expect(mockTextarea.scrollTop).toBe(12);
    });

    it('restores web selection through the handle without changing text', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onChangeText = vi.fn();
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const ref = React.createRef<WebMultiTextInputHandle>();

        await renderScreen(
            <MultiTextInput
                ref={ref}
                testID="composer-input"
                value="hello"
                onChangeText={onChangeText}
                onSelectionChange={onSelectionChange}
                onStateChange={onStateChange}
            />,
        );

        await act(async () => {
            ref.current?.setSelection({ start: 3, end: 3 });
        });

        expect(onChangeText).not.toHaveBeenCalled();
        expect(onSelectionChange).toHaveBeenCalledWith({ start: 3, end: 3 });
        expect(onStateChange).toHaveBeenCalledWith({
            text: 'hello',
            selection: { start: 3, end: 3 },
        });
    });

    it('restores web selection against the live DOM text when React carries a projected value', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onChangeText = vi.fn();
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const ref = React.createRef<WebMultiTextInputHandle>();
        const liveText = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /run`;
        const mockTextarea = {
            value: liveText,
            scrollTop: 0,
            scrollHeight: 30,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            focus: vi.fn(),
            blur: vi.fn(),
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
        };

        await act(async () => {
            renderer.create(
                <MultiTextInput
                    ref={ref}
                    testID="composer-input"
                    value=""
                    onChangeText={onChangeText}
                    onSelectionChange={onSelectionChange}
                    onStateChange={onStateChange}
                />,
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });

        await act(async () => {
            ref.current?.setSelection?.({ start: liveText.length, end: liveText.length });
        });

        expect(onChangeText).not.toHaveBeenCalled();
        expect(mockTextarea.setSelectionRange).toHaveBeenCalledWith(liveText.length, liveText.length);
        expect(onSelectionChange).toHaveBeenCalledWith({ start: liveText.length, end: liveText.length });
        expect(onStateChange).toHaveBeenCalledWith({
            text: liveText,
            selection: { start: liveText.length, end: liveText.length },
        });
    });

    it('does not imperatively restore web selection while IME composition is active', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const ref = React.createRef<WebMultiTextInputHandle>();
        const mockTextarea = {
            style: {},
            scrollHeight: 0,
            setSelectionRange: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        };
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <MultiTextInput
                    ref={ref}
                    testID="composer-input"
                    value="hello"
                    onChangeText={() => {}}
                    onSelectionChange={onSelectionChange}
                    onStateChange={onStateChange}
                />,
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });

        const input = tree!.root.findByType('textarea' as any);
        await act(async () => {
            input.props.onCompositionStart();
            ref.current?.setSelection({ start: 3, end: 3 });
        });

        expect(mockTextarea.setSelectionRange).not.toHaveBeenCalled();
        expect(onSelectionChange).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
    });

    it('prevents the default paste behavior when web files are pasted and forwards the files', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onFilesPasted = vi.fn();

        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'Inspect this image',
            onChangeText: () => {},
            onFilesPasted,
        }))).tree;

        const input = tree.findByType('textarea' as any);
        const preventDefault = vi.fn();
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        const pasteEvent = {
            preventDefault,
            clipboardData: {
                items: [{
                    kind: 'file',
                    getAsFile: () => file,
                }],
            },
        };

        input.props.onPaste(pasteEvent);

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onFilesPasted).toHaveBeenCalledWith([file]);
    });

    it('falls back to clipboardData.files when pasted file items cannot be materialized', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onFilesPasted = vi.fn();

        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'Inspect this image',
            onChangeText: () => {},
            onFilesPasted,
        }))).tree;

        const input = tree.findByType('textarea' as any);
        const preventDefault = vi.fn();
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        const pasteEvent = {
            preventDefault,
            clipboardData: {
                items: [{
                    kind: 'file',
                    getAsFile: () => null,
                }],
                files: [file],
            },
        };

        input.props.onPaste(pasteEvent);

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onFilesPasted).toHaveBeenCalledWith([file]);
    });
});
