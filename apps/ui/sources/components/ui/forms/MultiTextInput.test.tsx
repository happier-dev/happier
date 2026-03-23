import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
            View: 'View',
            TextInput: (props: any) => React.createElement('TextInput', props, null),
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
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
        const input = tree.root.findByType('TextInput' as any);
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
        const input = tree.root.findByType('TextareaAutosize' as any);
        expect(input.props['data-testid']).toBe('composer-input');
    });
});
