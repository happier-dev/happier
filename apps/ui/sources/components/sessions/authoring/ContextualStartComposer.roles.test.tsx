import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

// Device geometry and safe-area measurements are platform boundaries; composer and overlay policy stay real.
installPopoverCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: 390, height: 844 }),
        Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
    });
} });
vi.mock('react-native-safe-area-context', async () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }), initialWindowMetrics: null,
    SafeAreaInsetsContext: (await import('react')).createContext(null),
}));

const { View } = await import('react-native');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
const { ContextualStartComposerBody, useContextualStartComposer } = await import('./ContextualStartComposer');

describe('Contextual start role choices', () => {
    it('opens roles outside the form in a named phone sheet and closes after choosing', async () => {
        function Composer() {
            const model = useContextualStartComposer({ enabled: true, selectedIds: new Set(['reviewer']), where: null,
                sections: [{ category: 'newAgent', section: { kind: 'static', id: 'agents',
                    options: [{ id: 'reviewer', label: 'Reviewer', onSelect: () => undefined }] } }] },
            { who: ['newAgent'], machine: 'fixed', folder: 'fixed' });
            return <OverlayPortalProvider>
                <View testID="start-form"><ContextualStartComposerBody model={model}
                    whoAccessory={{ label: 'Reviewer role', render: close =>
                        <RoundButton testID="choose-role" title="Planner" onPress={close} /> }} /></View>
                <View testID="start-overlay"><OverlayPortalHost /></View>
            </OverlayPortalProvider>;
        }
        const screen = await renderScreen(<Composer />);
        await screen.pressByTestIdAsync('contextual-start-who-accessory');
        expect(screen.findByTestId('start-form')!.findAllByProps({ testID: 'choose-role' })).toHaveLength(0);
        expect(screen.findByTestId('start-overlay')!.findAllByProps({ testID: 'choose-role' }).length).toBeGreaterThan(0);
        expect(screen.findAll(node => node.props.role === 'dialog' && node.props.accessibilityLabel === 'Reviewer role').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('choose-role');
        expect(screen.findByTestId('choose-role')).toBeNull();
        await screen.unmount();
    });

    // U8 R2 E2: the role is a value chosen from a menu, so its trigger is the bordered field select and its
    // menu stands on the shared anchored popover's own surface, never bare over the sheet.
    it('opens the role menu from a field trigger onto the shared popover surface', async () => {
        function Composer() {
            const model = useContextualStartComposer({ enabled: true, selectedIds: new Set(['reviewer']), where: null,
                sections: [{ category: 'newAgent', section: { kind: 'static', id: 'agents',
                    options: [{ id: 'reviewer', label: 'Reviewer', onSelect: () => undefined }] } }] },
            { who: ['newAgent'], machine: 'fixed', folder: 'fixed' });
            return <OverlayPortalProvider>
                <View testID="start-form"><ContextualStartComposerBody model={model}
                    whoAccessory={{ label: 'Reviewer', render: close =>
                        <RoundButton testID="choose-role" title="Planner" onPress={close} /> }} /></View>
                <View testID="start-overlay"><OverlayPortalHost /></View>
            </OverlayPortalProvider>;
        }
        const screen = await renderScreen(<Composer />);
        const trigger = () => screen.findByTestId('contextual-start-who-accessory')!;
        expect(trigger().props.accessibilityState?.expanded ?? trigger().props.expanded).toBe(false);
        await screen.pressByTestIdAsync('contextual-start-who-accessory');
        expect(trigger().props.accessibilityState?.expanded ?? trigger().props.expanded).toBe(true);
        const surface = screen.findByTestId('contextual-start-who-accessory.popover');
        expect(surface).toBeTruthy();
        expect(surface!.findAllByProps({ testID: 'choose-role' }).length).toBeGreaterThan(0);
        await screen.unmount();
    });
});
