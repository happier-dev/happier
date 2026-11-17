import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TextInput as WebTextInput } from 'react-native-web';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { FieldTextInput } from './FieldTextInput';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

it.each([
    { label: 'a field with its own error', error: 'Email does not match', invalid: false, expectedInvalid: true },
    { label: 'a field with a separately rendered error', error: undefined, invalid: true, expectedInvalid: true },
    { label: 'a valid field', error: undefined, invalid: false, expectedInvalid: false },
])('exposes $label to assistive technology through the real web input', async ({ error, invalid, expectedInvalid }) => {
    const screen = await renderScreen(<FieldTextInput
        testID="email" value="person@example.test" onChangeText={() => {}}
        accessibilityLabel="Email" error={error} invalid={invalid}
        accessibilityDescribedBy={expectedInvalid ? 'email-error' : undefined}
    />);
    try {
        const input = screen.findByTestId('email')!;
        // The native host stub preserves props; the real RNW renderer must translate them to ARIA.
        const markup = renderToStaticMarkup(<WebTextInput {...input.props} />);
        if (expectedInvalid) {
            expect(markup).toContain('aria-invalid="true"');
            expect(markup).toContain('aria-describedby="email-error"');
        } else {
            expect(markup).not.toContain('aria-invalid="true"');
        }
    } finally {
        await screen.unmount();
    }
});
