import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown>) => React.createElement('Text', props),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

describe('FieldTextInput', () => {
    it('keeps an inline field action accessible beside its input', async () => {
        const { Pressable } = await import('react-native');
        const { FieldTextInput } = await import('./FieldTextInput');
        const onClear = vi.fn();
        const screen = await renderScreen(<FieldTextInput value="secret" onChangeText={() => {}} accessibilityLabel="API key"
            trailing={<Pressable testID="clear-secret" accessibilityRole="button" accessibilityLabel="Clear API key" onPress={onClear} />} />);
        await screen.pressByTestIdAsync('clear-secret');
        expect(onClear).toHaveBeenCalledOnce();
    });
    it('shows a value that can be read and selected but not changed', async () => {
        const onChangeText = vi.fn();
        const { FieldTextInput } = await import('./FieldTextInput');
        const screen = await renderScreen(
            <FieldTextInput
                testID="export-json"
                value='{"kind":"theme"}'
                onChangeText={onChangeText}
                accessibilityLabel="Theme JSON"
                multiline
                editable={false}
            />,
        );

        const input = screen.findByTestId('export-json');
        expect(input?.props.editable).toBe(false);
        expect(input?.props.value).toBe('{"kind":"theme"}');
    });

    it('announces the field state as its hint, and an error over it', async () => {
        const { FieldTextInput } = await import('./FieldTextInput');
        const props = { testID: 'token', value: '', onChangeText: () => {}, accessibilityLabel: 'Token', accessibilityHint: 'A token is saved' };
        const screen = await renderScreen(<FieldTextInput {...props} />);
        expect(screen.findByTestId('token')?.props.accessibilityHint).toBe('A token is saved');
        const invalid = await renderScreen(<FieldTextInput {...props} testID="token-invalid" error="Too short" />);
        expect(invalid.findByTestId('token-invalid')?.props.accessibilityHint).toBe('Too short');
    });

    it('takes the native touch floor on phones and keeps pointer density on web', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const { FieldTextInput } = await import('./FieldTextInput');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const minHeightOn = async (platform: 'ios' | 'android' | 'web') => {
            const screen = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                    <FieldTextInput testID="field" value="" onChangeText={() => {}} accessibilityLabel="Endpoint" />
                </HappierUiPlatformProvider>,
            );
            const value = flattenTestStyle(screen.findByTestId('field')!.props.style).minHeight;
            await screen.unmount();
            return value;
        };
        expect(await minHeightOn('ios')).toBe(44);
        expect(await minHeightOn('android')).toBe(48);
        expect(await minHeightOn('web')).toBeLessThan(44);
    });
});
