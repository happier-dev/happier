import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';


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

vi.mock('react-textarea-autosize', () => ({
    __esModule: true,
    default: (props: any) => React.createElement('TextareaAutosize', props, null),
}));

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

    it('forwards testID as data-testid on web textarea', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: '',
                    onChangeText: () => {},
                }))).tree;
        const input = tree.findByType('TextareaAutosize' as any);
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
        const input = tree.findByType('TextareaAutosize' as any);
        expect(input.props.style.fontSize).toBe('20px');
        expect(input.props.style.color).toBeDefined();
        expect(input.props.style.fontFamily).toBeDefined();
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
        const input = tree.findByType('TextareaAutosize' as any);

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

    it('prevents the default paste behavior when web files are pasted and forwards the files', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        const onFilesPasted = vi.fn();

        const tree = (await renderScreen(React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
            testID: 'composer-input',
            value: 'Inspect this image',
            onChangeText: () => {},
            onFilesPasted,
        }))).tree;

        const input = tree.findByType('TextareaAutosize' as any);
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

        const input = tree.findByType('TextareaAutosize' as any);
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
