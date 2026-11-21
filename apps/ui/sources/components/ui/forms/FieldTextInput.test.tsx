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

    it('fills its drawn field box on every platform rather than growing to a finger target', async () => {
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
        // A touch target is a hit area, not a drawn size: the input fills the 32 px box on phones too.
        expect(await minHeightOn('ios')).toBe(30);
        expect(await minHeightOn('android')).toBe(30);
        expect(await minHeightOn('web')).toBe(30);
    });
    it('grows a multiline field with its text only when asked, so a whole decision stays visible', async () => {
        const { FieldTextInput } = await import('./FieldTextInput');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const { act } = await import('react-test-renderer');
        const heightAfterResize = async (growWithText: boolean) => {
            const screen = await renderScreen(
                <FieldTextInput testID="field" value="A long decision that wraps" onChangeText={() => {}}
                    accessibilityLabel="Decision" multiline minLines={2} growWithText={growWithText} />,
            );
            const input = screen.findByTestId('field')!;
            await act(async () => { input.props.onContentSizeChange?.({ nativeEvent: { contentSize: { height: 96 } } }); });
            const style = flattenTestStyle(screen.findByTestId('field')!.props.style);
            await screen.unmount();
            return style.height;
        };
        expect(await heightAfterResize(true)).toBe(96);
        expect(await heightAfterResize(false)).toBeUndefined();
    });
    it('drops a height measured under a taller minimum when the minimum shrinks (Describe fills its sheet, then settles)', async () => {
        const { FieldTextInput } = await import('./FieldTextInput');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const { act } = await import('react-test-renderer');
        const field = (minLines: number) => <FieldTextInput testID="field" value="Two short lines" onChangeText={() => {}}
            accessibilityLabel="Description" multiline minLines={minLines} growWithText />;
        const screen = await renderScreen(field(26));
        // The web reports the taller of the text and the box, so a tall minimum comes back as the measured height.
        await act(async () => { screen.findByTestId('field')!.props.onContentSizeChange?.({ nativeEvent: { contentSize: { height: 520 } } }); });
        expect(flattenTestStyle(screen.findByTestId('field')!.props.style).height).toBe(520);
        await screen.update(field(4));
        expect(flattenTestStyle(screen.findByTestId('field')!.props.style).height).toBeUndefined();
        await screen.unmount();
    });
});
