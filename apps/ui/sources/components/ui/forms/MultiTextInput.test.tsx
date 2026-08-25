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
const recordLargeTextInputDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiFontScale') return localSettingState.uiFontScale;
        return undefined;
    },
}));

vi.mock('@/utils/system/userInteractionDiagnostics', () => ({
    recordLargeTextInputDiagnostic: (...args: unknown[]) => recordLargeTextInputDiagnosticMock(...args),
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
        recordLargeTextInputDiagnosticMock.mockReset();
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

    it('forwards combobox role and expanded state to the native TextInput owner', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const tree = (await renderScreen(<MultiTextInput
            value="/help"
            onChangeText={() => {}}
            accessibilityRole="combobox"
            accessibilityState={{ expanded: true }}
        />)).tree;

        const input = tree.findByType('TextInput' as any);
        expect(input.props.accessibilityRole).toBe('combobox');
        expect(input.props.accessibilityState).toEqual({ expanded: true });
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

    it('records native large-text changes with selection metadata only', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value=""
            onChangeText={() => {}}
        />);
        const input = screen.tree.findByType('TextInput' as any);
        const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);

        await act(async () => {
            input.props.onChangeText(largeText);
        });

        expect(recordLargeTextInputDiagnosticMock).toHaveBeenCalledWith({
            phase: 'native-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: largeText.length,
            selection: { start: largeText.length, end: largeText.length },
            valueLength: 0,
        });
    });

    it('records native large-text content-size changes with height metadata only', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value={largeText}
            maxHeight={144}
            onChangeText={() => {}}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onContentSizeChange({
                nativeEvent: {
                    contentSize: { height: 220.4 },
                },
            });
        });

        expect(recordLargeTextInputDiagnosticMock).toHaveBeenCalledWith({
            phase: 'native-content-size',
            platform: 'web',
            surface: 'agentInput',
            textLength: largeText.length,
            contentHeight: 221,
            maxHeight: 144,
        });
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

    it('reports the post-paste cursor after inserted native text instead of forcing document end', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onStateChange = vi.fn();
        const prefix = 'before ';
        const suffix = ' after';
        const initialText = `${prefix}${suffix}`;
        const insertedText = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /r`;
        const pastedText = `${prefix}${insertedText}${suffix}`;
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value={initialText}
            onChangeText={() => {}}
            onStateChange={onStateChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onSelectionChange({
                nativeEvent: { selection: { start: prefix.length, end: prefix.length } },
            });
            input.props.onChangeText(pastedText);
        });

        expect(onStateChange).toHaveBeenLastCalledWith({
            text: pastedText,
            selection: {
                start: prefix.length + insertedText.length,
                end: prefix.length + insertedText.length,
            },
        });
    });

    it('keeps initially oversized native text as the full editable TextInput value', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<NativeMultiTextInputHandle>();
        const largeText = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)}TAIL`;

        const screen = await renderScreen(<MultiTextInput
            ref={ref}
            testID="composer-input"
            value={largeText}
            onChangeText={() => {}}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        expect(input.props.value).toBe(largeText);
        expect(input.props.defaultValue).toBeUndefined();
        expect(input.props.maxLength).toBeUndefined();
        expect(ref.current?.getText()).toBe(largeText);
    });

    it('propagates oversized native text changes immediately without capping the native value', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<NativeMultiTextInputHandle>();
        const onChangeText = vi.fn();
        const onStateChange = vi.fn();
        const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);

        const screen = await renderScreen(<MultiTextInput
            ref={ref}
            testID="composer-input"
            value=""
            onChangeText={onChangeText}
            onStateChange={onStateChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);
        expect(input.props.maxLength).toBeUndefined();

        await act(async () => {
            input.props.onChangeText(largeText);
        });

        expect(ref.current?.getText()).toBe(largeText);
        expect(onChangeText).toHaveBeenCalledWith(largeText);
        expect(onStateChange).toHaveBeenLastCalledWith({
            text: largeText,
            selection: { start: largeText.length, end: largeText.length },
        });
    });

    it('applies externally controlled oversized native text as the full native value', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const nativeInputNode = {
            setNativeProps: vi.fn(),
            measureInWindow: vi.fn(),
            focus: vi.fn(),
            blur: vi.fn(),
        };
        const largeText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);

        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value="short"
            onChangeText={() => {}}
        />, {
            createNodeMock: (element) => (element.type === 'TextInput' ? nativeInputNode : null),
        });

        await screen.update(<MultiTextInput
            testID="composer-input"
            value={largeText}
            onChangeText={() => {}}
        />);

        const input = screen.tree.findByType('TextInput' as any);
        expect(input.props.value).toBe(largeText);
        expect(input.props.defaultValue).toBeUndefined();
        expect(input.props.maxLength).toBeUndefined();
        expect(nativeInputNode.setNativeProps).not.toHaveBeenCalledWith(expect.objectContaining({
            text: expect.any(String),
        }));
    });

    it('infers the cursor at the end when native appends to a large input after stale selection state', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onStateChange = vi.fn();
        const initialText = Array.from(
            { length: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1 },
            (_, index) => String.fromCharCode(97 + (index % 26)),
        ).join('');
        const nextText = `${initialText} /r`;
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value={initialText}
            onChangeText={() => {}}
            onStateChange={onStateChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onSelectionChange({
                nativeEvent: { selection: { start: 0, end: 0 } },
            });
            input.props.onChangeText(nextText);
        });

        expect(onStateChange).toHaveBeenLastCalledWith({
            text: nextText,
            selection: {
                start: nextText.length,
                end: nextText.length,
            },
        });
    });

    it('accepts native selection updates for the latest native text before controlled value catches up', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onStateChange = vi.fn();
        const initialText = 'hello';
        const nextText = `${initialText} /r`;
        const screen = await renderScreen(<MultiTextInput
            testID="composer-input"
            value={initialText}
            onChangeText={() => {}}
            onStateChange={onStateChange}
        />);
        const input = screen.tree.findByType('TextInput' as any);

        await act(async () => {
            input.props.onSelectionChange({
                nativeEvent: { selection: { start: 0, end: 0 } },
            });
            input.props.onChangeText(nextText);
            input.props.onSelectionChange({
                nativeEvent: { selection: { start: nextText.length, end: nextText.length } },
            });
        });

        expect(onStateChange).toHaveBeenLastCalledWith({
            text: nextText,
            selection: {
                start: nextText.length,
                end: nextText.length,
            },
        });
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

    it('dedupes web content height reports before notifying callers', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onContentHeightChange = vi.fn();
        const mockTextarea = {
            value: 'line',
            selectionStart: 4,
            selectionEnd: 4,
            scrollTop: 0,
            scrollHeight: 88,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            focus: vi.fn(),
            blur: vi.fn(),
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <MultiTextInput
                    testID="composer-input"
                    value="line"
                    maxHeight={144}
                    onChangeText={() => {}}
                    onContentHeightChange={onContentHeightChange}
                />,
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });

        expect(onContentHeightChange).toHaveBeenCalledTimes(1);
        expect(onContentHeightChange).toHaveBeenCalledWith(88);

        await act(async () => {
            tree!.update(
                <MultiTextInput
                    testID="composer-input"
                    value="line"
                    maxHeight={144}
                    onChangeText={() => {}}
                    onContentHeightChange={onContentHeightChange}
                    textStyle={{ fontSize: 15 }}
                />,
            );
        });

        expect(onContentHeightChange).toHaveBeenCalledTimes(1);

        mockTextarea.scrollHeight = 96;
        await act(async () => {
            tree!.update(
                <MultiTextInput
                    testID="composer-input"
                    value="line"
                    maxHeight={144}
                    onChangeText={() => {}}
                    onContentHeightChange={onContentHeightChange}
                    textStyle={{ fontSize: 16 }}
                />,
            );
        });

        expect(onContentHeightChange).toHaveBeenCalledTimes(2);
        expect(onContentHeightChange).toHaveBeenLastCalledWith(96);
    });

    it('reports true web content height for oversized text so the expand toggle can appear', async () => {
        // The oversized branch skips the collapse-to-measure autosize pass and
        // used to report the CLAMPED max height as the content height. The
        // expand toggle only shows when reported content height exceeds the
        // collapsed max height, so for >50k-char messages the toggle silently
        // disappeared. A plain scrollHeight read (no style mutation, no
        // collapse reflow) gives the true content height.
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onContentHeightChange = vi.fn();
        const largeValue = 'a'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        const mockTextarea = {
            value: largeValue,
            selectionStart: largeValue.length,
            selectionEnd: largeValue.length,
            scrollTop: 0,
            scrollHeight: 8000,
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
                    testID="composer-input-large"
                    value={largeValue}
                    maxHeight={144}
                    onChangeText={() => {}}
                    onContentHeightChange={onContentHeightChange}
                />,
                {
                    createNodeMock: (element) => {
                        if (element.type === 'textarea') return mockTextarea;
                        return null;
                    },
                },
            );
        });

        expect(onContentHeightChange).toHaveBeenCalledWith(8000);
        // The rendered box itself stays clamped to the max height.
        expect(mockTextarea.style.height).toBe('144px');
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

    it('does not overwrite a newer pending oversized web edit with a stale controlled value replay', async () => {
        vi.useFakeTimers();
        try {
            const { MultiTextInput } = await import('./MultiTextInput.web');
            const onChangeText = vi.fn();
            const baseText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
            const firstEdit = `${baseText}\nQRST`;
            const secondEdit = `${firstEdit}UV`;
            const mockTextarea = {
                value: baseText,
                selectionStart: baseText.length,
                selectionEnd: baseText.length,
                scrollTop: 0,
                scrollHeight: 120,
                style: {} as Record<string, string>,
                setSelectionRange: vi.fn((start: number, end: number) => {
                    mockTextarea.selectionStart = start;
                    mockTextarea.selectionEnd = end;
                }),
                dispatchEvent: vi.fn(),
                focus: vi.fn(),
                blur: vi.fn(),
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
            };

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(
                    <MultiTextInput
                        testID="composer-input"
                        value={baseText}
                        onChangeText={onChangeText}
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

            mockTextarea.value = firstEdit;
            mockTextarea.selectionStart = firstEdit.length;
            mockTextarea.selectionEnd = firstEdit.length;
            await act(async () => {
                input.props.onChange({
                    target: mockTextarea,
                    currentTarget: mockTextarea,
                });
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(onChangeText).toHaveBeenCalledWith(firstEdit);

            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={firstEdit}
                        onChangeText={onChangeText}
                    />,
                );
            });

            mockTextarea.value = secondEdit;
            mockTextarea.selectionStart = secondEdit.length;
            mockTextarea.selectionEnd = secondEdit.length;
            await act(async () => {
                input.props.onChange({
                    target: mockTextarea,
                    currentTarget: mockTextarea,
                });
            });

            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={baseText}
                        onChangeText={onChangeText}
                    />,
                );
            });

            expect(mockTextarea.value).toBe(secondEdit);
            expect(mockTextarea.selectionStart).toBe(secondEdit.length);
            expect(mockTextarea.selectionEnd).toBe(secondEdit.length);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not roll back flushed oversized web text when a superseded emission replays late', async () => {
        // The oversized round-trip is double-deferred (input debounce + parent
        // sync deferral), so an older emission can echo back through props
        // AFTER the input already emitted a newer one and went idle
        // (pending === null). Only lastEmitted was checked, so the replay fell
        // through to reconcile, rewrote node.value to the older text, and
        // rolled back ~0.5-1.5s of typing with a caret jump. Any value this
        // input itself emitted must never be adopted as external content.
        vi.useFakeTimers();
        try {
            const { MultiTextInput } = await import('./MultiTextInput.web');
            const onChangeText = vi.fn();
            const baseText = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
            const firstEdit = `${baseText}\nQRST`;
            const secondEdit = `${firstEdit}UV`;
            const externalText = `${baseText}\nEXTERNAL`;
            const mockTextarea = {
                value: baseText,
                selectionStart: baseText.length,
                selectionEnd: baseText.length,
                scrollTop: 0,
                scrollHeight: 120,
                style: {} as Record<string, string>,
                setSelectionRange: vi.fn((start: number, end: number) => {
                    mockTextarea.selectionStart = start;
                    mockTextarea.selectionEnd = end;
                }),
                dispatchEvent: vi.fn(),
                focus: vi.fn(),
                blur: vi.fn(),
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
            };

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(
                    <MultiTextInput
                        testID="composer-input"
                        value={baseText}
                        onChangeText={onChangeText}
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

            // Two flushed edits while the parent round-trip is still in flight.
            mockTextarea.value = firstEdit;
            mockTextarea.selectionStart = firstEdit.length;
            mockTextarea.selectionEnd = firstEdit.length;
            await act(async () => {
                input.props.onChange({
                    target: mockTextarea,
                    currentTarget: mockTextarea,
                });
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(onChangeText).toHaveBeenCalledWith(firstEdit);

            mockTextarea.value = secondEdit;
            mockTextarea.selectionStart = secondEdit.length;
            mockTextarea.selectionEnd = secondEdit.length;
            await act(async () => {
                input.props.onChange({
                    target: mockTextarea,
                    currentTarget: mockTextarea,
                });
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(onChangeText).toHaveBeenCalledWith(secondEdit);

            // The delayed parent render replays the superseded first emission.
            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={firstEdit}
                        onChangeText={onChangeText}
                    />,
                );
            });

            expect(mockTextarea.value).toBe(secondEdit);
            expect(mockTextarea.selectionStart).toBe(secondEdit.length);
            expect(mockTextarea.selectionEnd).toBe(secondEdit.length);

            // After the parent confirms the latest emission, a genuinely
            // external value must still be adopted.
            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={secondEdit}
                        onChangeText={onChangeText}
                    />,
                );
            });
            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={externalText}
                        onChangeText={onChangeText}
                    />,
                );
            });
            expect(mockTextarea.value).toBe(externalText);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not roll back live short text when an earlier emitted value replays through props', async () => {
        vi.useFakeTimers();
        try {
            const { MultiTextInput } = await import('./MultiTextInput.web');
            const onChangeText = vi.fn();
            const completeEdit = 'hello world hello world hello world';
            const emittedValues = Array.from(
                { length: completeEdit.length },
                (_, index) => completeEdit.slice(0, index + 1),
            );
            const firstEdit = emittedValues[0]!;
            const latestEdit = emittedValues[emittedValues.length - 1]!;
            const externalText = 'continued on another device';
            const mockTextarea = {
                value: '',
                selectionStart: 0,
                selectionEnd: 0,
                scrollTop: 0,
                scrollHeight: 30,
                style: {} as Record<string, string>,
                setSelectionRange: vi.fn(),
                dispatchEvent: vi.fn(),
                focus: vi.fn(),
                blur: vi.fn(),
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
            };

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(
                    <MultiTextInput
                        testID="composer-input"
                        value=""
                        onChangeText={onChangeText}
                    />,
                    {
                        createNodeMock: (element) => (element.type === 'textarea' ? mockTextarea : null),
                    },
                );
            });
            const input = tree!.root.findByType('textarea' as any);

            for (const text of emittedValues) {
                mockTextarea.value = text;
                mockTextarea.selectionStart = text.length;
                mockTextarea.selectionEnd = text.length;
                await act(async () => {
                    input.props.onChange({ target: mockTextarea, currentTarget: mockTextarea });
                });
            }

            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={firstEdit}
                        onChangeText={onChangeText}
                    />,
                );
            });
            expect(mockTextarea.value).toBe(latestEdit);

            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={latestEdit}
                        onChangeText={onChangeText}
                    />,
                );
            });

            await act(async () => {
                tree!.update(
                    <MultiTextInput
                        testID="composer-input"
                        value={externalText}
                        onChangeText={onChangeText}
                    />,
                );
            });
            expect(mockTextarea.value).toBe(externalText);
        } finally {
            vi.useRealTimers();
        }
    });

    it('records web large-text changes with live value metadata only', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: '',
            onChangeText: () => {},
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

        expect(recordLargeTextInputDiagnosticMock).toHaveBeenCalledWith({
            phase: 'web-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: largeText.length,
            selection: { start: largeText.length, end: largeText.length },
            valueLength: 0,
            liveTextLength: largeText.length,
            pendingTextLength: largeText.length,
        });
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

    // "does not reapply web scroll restore on controlled value changes without
    // a new restore token" was consolidated into "re-applies a consumed web
    // scroll restore after adopting an external value, but never after
    // self-edit confirms": it simulated typing by mutating the controlled
    // value without firing onChange, which at this seam is an external
    // adoption — and adoptions now correctly re-apply the restore because the
    // node.value write resets the browser scroll position.

    it('preserves the composer scroll position across the autosize measurement while typing', async () => {
        // Autosize measures by collapsing the box to `height: auto`. With the
        // box grown to fit its content the maximum scroll offset is 0, so the
        // browser clamps the textarea's own scrollTop and the visible text
        // jumps to the top on every keystroke once the draft overflows. This
        // used to be masked: the restore token churned on every persist write,
        // so the scroll-restore effect re-pinned scrollTop right after each
        // measurement. The measurement must preserve it itself.
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const initialValue = 'a'.repeat(600);
        let backingValue = initialValue;
        const styleValues: Record<string, string> = {};
        const style = {} as Record<string, string>;
        const mockTextareaBase = {
            selectionStart: 0,
            selectionEnd: 0,
            scrollTop: 0,
            scrollHeight: 2000,
            style,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            focus: vi.fn(),
            blur: vi.fn(),
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
        };
        Object.defineProperty(style, 'height', {
            get: () => styleValues.height ?? '',
            set: (next: string) => {
                styleValues.height = next;
                // Browser semantics: once the box fits its own content the
                // maximum scroll offset is 0, so scrollTop is clamped away.
                if (next === 'auto') mockTextareaBase.scrollTop = 0;
            },
            enumerable: true,
            configurable: true,
        });
        Object.defineProperty(mockTextareaBase, 'value', {
            get: () => backingValue,
            set: (next: string) => {
                backingValue = next;
                mockTextareaBase.scrollTop = 0;
            },
        });
        const mockTextarea = mockTextareaBase as typeof mockTextareaBase & { value: string };

        const renderInput = (value: string) => (
            <MultiTextInput
                testID="composer-input"
                value={value}
                maxHeight={144}
                onChangeText={() => {}}
            />
        );

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(renderInput(initialValue), {
                createNodeMock: (element) => {
                    if (element.type === 'textarea') return mockTextarea;
                    return null;
                },
            });
        });

        // The user scrolls up inside the composer to reread an earlier line.
        mockTextarea.scrollTop = 250;

        const input = tree.root.findByType('textarea' as any);
        const editedValue = `${initialValue}x`;
        await act(async () => {
            backingValue = editedValue;
            input.props.onChange({ target: mockTextarea, currentTarget: mockTextarea });
        });
        expect(mockTextarea.scrollTop).toBe(250);

        // The parent confirm of that same edit re-runs the measurement pass.
        await act(async () => {
            tree.update(renderInput(editedValue));
        });
        expect(mockTextarea.scrollTop).toBe(250);
    });

    it('re-applies a consumed web scroll restore after adopting an external value, but never after self-edit confirms', async () => {
        // Adopting an external value assigns node.value, which resets the
        // browser's scrollTop. A scroll restore consumed before the adoption
        // (session open applies it before the async draft text lands) must be
        // re-applied against the adopted content — while parent confirms of
        // the input's own edits must never re-apply it (that re-application
        // was the 2026-07-22 caret/scroll drag).
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const initialValue = 'a'.repeat(600);
        const adoptedValue = 'b'.repeat(600);
        let backingValue = initialValue;
        const mockTextareaBase = {
            selectionStart: 0,
            selectionEnd: 0,
            scrollTop: 0,
            scrollHeight: 2000,
            style: {} as Record<string, string>,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            focus: vi.fn(),
            blur: vi.fn(),
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
        };
        Object.defineProperty(mockTextareaBase, 'value', {
            get: () => backingValue,
            set: (next: string) => {
                backingValue = next;
                // Browsers reset the scroll position on programmatic value writes.
                mockTextareaBase.scrollTop = 0;
            },
        });
        const mockTextarea = mockTextareaBase as typeof mockTextareaBase & { value: string };

        const renderInput = (value: string) => (
            <MultiTextInput
                testID="composer-input"
                value={value}
                maxHeight={144}
                initialScrollY={120}
                scrollRestoreToken="session-a:scope:0:adopted"
                onChangeText={() => {}}
            />
        );

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(renderInput(initialValue), {
                createNodeMock: (element) => {
                    if (element.type === 'textarea') return mockTextarea;
                    return null;
                },
            });
        });
        expect(mockTextarea.scrollTop).toBe(120);

        // External adoption (e.g. async draft load) resets scrollTop via the
        // node.value write; the pending restore must be re-applied.
        await act(async () => {
            tree.update(renderInput(adoptedValue));
        });
        expect(mockTextarea.value).toBe(adoptedValue);
        expect(mockTextarea.scrollTop).toBe(120);

        // A parent confirm of the input's own edit must NOT re-apply the
        // restore over the user's live scroll position.
        const input = tree.root.findByType('textarea' as any);
        const editedValue = `${adoptedValue}x`;
        await act(async () => {
            backingValue = editedValue;
            input.props.onChange({ target: mockTextarea, currentTarget: mockTextarea });
        });
        mockTextarea.scrollTop = 333;
        await act(async () => {
            tree.update(renderInput(editedValue));
        });
        expect(mockTextarea.scrollTop).toBe(333);
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

    // Contract updated 2026-07-22: while the live DOM text is ahead of the
    // controlled value (large-text round-trip in flight), an imperative
    // selection was computed against a different text basis and must be
    // DROPPED, matching the native guard. Applying it against the live text
    // dragged the user's caret backwards mid-typing (web composer incident).
    it('drops web selection restores while React carries a projected value behind the live DOM text', async () => {
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
        expect(mockTextarea.setSelectionRange).not.toHaveBeenCalled();
        expect(onSelectionChange).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
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

    it('attaches a clipboard file once when items and files expose different objects for the same image', async () => {
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
        const itemFile = new File([new Uint8Array([1, 2, 3])], 'image.png', {
            type: 'image/png',
            lastModified: 2,
        });
        const fileListFile = new File([new Uint8Array([1, 2, 3])], 'image.png', {
            type: 'image/png',
            lastModified: 1,
        });

        input.props.onPaste({
            preventDefault,
            clipboardData: {
                items: [{
                    kind: 'file',
                    getAsFile: () => itemFile,
                }],
                files: [fileListFile],
            },
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onFilesPasted).toHaveBeenCalledWith([itemFile]);
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
