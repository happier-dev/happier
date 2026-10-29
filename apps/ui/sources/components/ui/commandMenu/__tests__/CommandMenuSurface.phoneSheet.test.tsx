import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => viewport,
            Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
        });
    },
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
    initialWindowMetrics: null,
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => { standardCleanup(); viewport.width = 390; viewport.height = 844; });

const menu = async (phoneSheetTitle?: string) => {
    const { CommandMenuSurface } = await import('../CommandMenuSurface');
    return renderScreen(<CommandMenuSurface open anchor={{ kind: 'rect', rect: { left: 20, top: 700, width: 350, height: 40 } }}
        phoneSheetTitle={phoneSheetTitle} onRequestClose={() => {}}>{React.createElement('MenuBody')}</CommandMenuSurface>);
};

describe('a command menu that asks for the phone sheet', () => {
    it('presents the shared, named sheet on a phone and stays an anchored popover when not asked or on a wide screen', async () => {
        const phone = await menu('Prompts');
        expect(phone.findAll((node) => node.props.role === 'dialog')[0]?.props.accessibilityLabel).toBe('Prompts');
        expect(phone.findByTestId('popover-sheet.close')).not.toBeNull();
        expect(phone.findByType('MenuBody')).not.toBeNull();
        standardCleanup();
        expect((await menu()).findAll((node) => node.props.role === 'dialog').length).toBe(0);
        standardCleanup();
        viewport.width = 1200;
        viewport.height = 900;
        const wide = await menu('Prompts');
        expect(wide.findAll((node) => node.props.role === 'dialog').length).toBe(0);
        expect(wide.findByType('MenuBody')).not.toBeNull();
    });
});
