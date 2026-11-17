import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';


const actEnvironmentGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('Switch.web', () => {
    const previousActEnvironment = actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT;

    beforeEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it('exposes aria-checked for web switch semantics', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(<Switch
                    value
                    onValueChange={() => {}}
                    testID="settings-toggle"
                />);

        const pressable = screen.findByTestId('settings-toggle');
        if (!pressable) {
            throw new Error('Expected switch pressable to render');
        }
        // The shared switch owner emits the web `role` arm; either arm is the DOM role on RN Web.
        expect(pressable.props.role ?? pressable.props.accessibilityRole).toBe('switch');
        expect(pressable.props['aria-checked']).toBe(true);
    });

    it('keeps compact switches on a named 44px focus and interaction target', async () => {
        const { Switch } = await import('./Switch.web');
        const onValueChange = vi.fn();
        const screen = await renderScreen(<Switch
            value={false}
            onValueChange={onValueChange}
            accessibilityLabel="Fast responses"
            testID="compact-settings-toggle"
            compact
        />);

        const pressable = screen.findByTestId('compact-settings-toggle');
        if (!pressable) {
            throw new Error('Expected compact switch pressable to render');
        }
        const track = screen.findAll(node => typeof node.type === 'string' && node.props.dataSet?.surface === 'switch' && node.props.dataSet?.part === 'track')[0];
        expect(track).toBeDefined();
        const flattened = flattenTestStyle(track!.props.style);

        expect(pressable.props.accessibilityLabel).toBe('Fast responses');
        expect(pressable.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
        // Drawn at its compact track; the shared hit-area owner reaches the 44px target past it.
        expect(flattened.width).toBeLessThan(44);
        const area = readHitArea(pressable);
        expect(area.width).toBeGreaterThanOrEqual(44);
        expect(area.height).toBeGreaterThanOrEqual(44);

        const event = { key: ' ', nativeEvent: { key: ' ' }, preventDefault: vi.fn() };
        pressable.props.onKeyDown(event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(onValueChange).toHaveBeenCalledWith(true);
    });
});
