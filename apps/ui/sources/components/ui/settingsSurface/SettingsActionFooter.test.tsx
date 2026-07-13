import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const bottomChromeHeightState = vi.hoisted(() => ({ value: 0 }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: {
                        select: <T,>(options: { default?: T; ios?: T }) => options.default ?? options.ios ?? null,
                    },
                    Dimensions: {
                        get: () => ({ width: 1440, height: 900 }),
                    },
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', { ...props, testID: 'settings-action-footer-item-group' }, props.children),
}));

vi.mock('@/components/ui/forms/SplitActionButtons', () => ({
    SplitActionButtons: (props: any) => React.createElement('SplitActionButtons', { ...props, testID: 'settings-action-footer-buttons' }),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: () => bottomChromeHeightState.value,
}));

describe('SettingsActionFooter', () => {
    it('does not reserve bottom chrome by default for footers nested inside an ItemList', async () => {
        bottomChromeHeightState.value = 80;
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        const screen = await renderScreen(React.createElement(SettingsActionFooter, {
            primaryLabel: 'Save',
            onPrimaryPress: vi.fn(),
        }));

        const container = screen.root.findAllByType('View')[1];
        expect(container.props.style[0]).toEqual(expect.objectContaining({ paddingBottom: 16 }));
        expect(container.props.style[1]).toBeNull();
        bottomChromeHeightState.value = 0;
    });

    it('reserves mobile bottom chrome when the footer is a sibling of the ItemList', async () => {
        bottomChromeHeightState.value = 80;
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        const screen = await renderScreen(React.createElement(SettingsActionFooter, {
            primaryLabel: 'Save',
            onPrimaryPress: vi.fn(),
            reserveBottomChromeInset: true,
        }));

        const container = screen.root.findAllByType('View')[1];
        expect(container.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ paddingBottom: 16 }),
            { paddingBottom: 96 },
        ]));
        bottomChromeHeightState.value = 0;
    });

    it('renders split actions without wrapping them in an item group', async () => {
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        const screen = await renderScreen(React.createElement(SettingsActionFooter, {
            primaryLabel: 'Save',
            onPrimaryPress: vi.fn(),
            secondaryLabel: 'Cancel',
            onSecondaryPress: vi.fn(),
        }));

        expect(screen.findByTestId('settings-action-footer-buttons')).toBeTruthy();
        expect(screen.findByTestId('settings-action-footer-item-group')).toBeNull();
        const container = screen.root.findAllByType('View')[1];
        expect(container.props.style[0]).toEqual(expect.objectContaining({ paddingBottom: 16 }));
        expect(container.props.style[1]).toBeNull();
    });

    it('keeps the base inset when bottom-chrome reservation is enabled but chrome height is zero', async () => {
        bottomChromeHeightState.value = 0;
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        const screen = await renderScreen(React.createElement(SettingsActionFooter, {
            primaryLabel: 'Save',
            onPrimaryPress: vi.fn(),
            reserveBottomChromeInset: true,
        }));

        const container = screen.root.findAllByType('View')[1];
        expect(container.props.style[0]).toEqual(expect.objectContaining({ paddingBottom: 16 }));
        expect(container.props.style[1]).toBeNull();
    });

    it('does not render an empty secondary action when no secondary label is provided', async () => {
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        const screen = await renderScreen(React.createElement(SettingsActionFooter, {
            primaryLabel: 'Save',
            onPrimaryPress: vi.fn(),
        }));

        expect(screen.findByTestId('settings-action-footer-buttons')?.props.secondaryLabel).toBeUndefined();
    });
});
