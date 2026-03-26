import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('MultiTextInput', () => {
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
});
