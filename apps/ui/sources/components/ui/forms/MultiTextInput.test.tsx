import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: { ...(actual.Platform ?? {}), OS: 'web' },
        View: 'View',
        TextInput: (props: any) => React.createElement('TextInput', props, null),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { text: '#111', placeholder: '#777' },
            },
        },
    }),
}));

vi.mock('react-textarea-autosize', () => ({
    __esModule: true,
    default: (props: any) => React.createElement('TextareaAutosize', props, null),
}));

describe('MultiTextInput', () => {
    it('forwards testID to the TextInput', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <MultiTextInput
                    testID="composer-input"
                    value=""
                    onChangeText={() => {}}
                />,
            );
        });
        const input = tree.root.findByType('TextInput' as any);
        expect(input.props.testID).toBe('composer-input');
    });

    it('forwards testID as data-testid on web textarea', async () => {
        const { MultiTextInput } = await import('./MultiTextInput.web');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput as unknown as React.ComponentType<Record<string, unknown>>, {
                    testID: 'composer-input',
                    value: '',
                    onChangeText: () => {},
                }),
            );
        });
        const input = tree.root.findByType('TextareaAutosize' as any);
        expect(input.props['data-testid']).toBe('composer-input');
    });
});
