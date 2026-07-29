import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

describe('MachineSetupTextField', () => {
    it('associates labels and validation text with the input', async () => {
        const { MachineSetupTextField } = await import('./MachineSetupTextField');
        const screen = await renderScreen(<MachineSetupTextField
            testID="endpoint"
            label="Endpoint"
            value="invalid"
            errorText="Enter a valid endpoint"
            onChangeText={() => {}}
        />);

        const input = screen.findByType('TextInput');
        expect(input.props.accessibilityLabel).toBe('Endpoint');
        expect(input.props.accessibilityState).toEqual(expect.objectContaining({ invalid: true }));
        expect(input.props.accessibilityDescribedBy).toBe('endpoint-support');
        expect(screen.findByProps({ nativeID: 'endpoint-support' }).props.children).toBe('Enter a valid endpoint');
    });

    it('associates support text even when the caller has no test id', async () => {
        const { MachineSetupTextField } = await import('./MachineSetupTextField');
        const screen = await renderScreen(<MachineSetupTextField
            label="Model IDs"
            value=""
            supportText="Enter one per line"
            onChangeText={() => {}}
        />);
        const input = screen.findByType('TextInput');
        expect(input.props.accessibilityDescribedBy).toEqual(expect.any(String));
        expect(input.props.accessibilityDescribedBy.length).toBeGreaterThan(0);
        expect(screen.findByProps({ nativeID: input.props.accessibilityDescribedBy }).props.children)
            .toBe('Enter one per line');
    });
});
