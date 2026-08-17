import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#007aff' },
                border: { default: '#dddddd', strong: '#111111' },
                surface: {
                    pressedOverlay: 'rgba(17,17,17,0.05)',
                    selected: '#ddeeff',
                },
                text: {
                    primary: '#111111',
                    secondary: '#666666',
                },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({ open: props.open, toggle: () => props.onOpenChange?.(!props.open) })
            : props.trigger,
    ),
}));

describe('WizardChoiceRow', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the command-palette style row and invokes the press handler', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Cloud',
            subtitle: 'Hosted relay',
            icon: 'cloud',
            badge: 'Recommended',
            selected: true,
            onPress,
        }));

        expect(screen.findByTestId('wizard-choice')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Cloud');
        expect(screen.getTextContent()).toContain('Hosted relay');
        expect(screen.getTextContent()).toContain('Recommended');

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice');
        });

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('keeps the row disabled while allowing the secondary action button to remain interactive', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();
        const onRetry = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Offline Relay',
            subtitle: 'https://unreachable.example.test',
            icon: 'link',
            badge: 'Unavailable',
            selected: true,
            disabled: true,
            secondaryAction: {
                testID: 'wizard-choice-retry',
                title: 'Retry',
                onPress: onRetry,
            },
            onPress,
        }));

        const row = screen.findByTestId('wizard-choice');
        expect(row).toBeTruthy();

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice');
        });
        expect(onPress).toHaveBeenCalledTimes(0);

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice-retry');
        });
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not invoke the row press handler when opening the overflow menu', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();
        const onRetry = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Offline Relay',
            subtitle: 'https://unreachable.example.test',
            icon: 'link',
            badge: 'Unreachable',
            selected: false,
            disabled: false,
            menuActions: [{
                id: 'retry',
                title: 'Retry',
                onPress: onRetry,
            }],
            onPress,
        }));

        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        expect(overflowTrigger).toBeTruthy();

        await act(async () => {
            overflowTrigger!.props.onPress?.({} as any);
        });

        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('uses neutral foreground icons for selected rows', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'Hosted relay',
            icon: 'cloud',
            selected: true,
            onPress: vi.fn(),
        }));

        const iconColors = screen.findAllByType('Icon' as any)
            .map((icon) => icon.props.color)
            .filter((color): color is string => typeof color === 'string');

        expect(iconColors).toContain('#111111');
        expect(iconColors).not.toContain('#007aff');
    });

    it('keeps radio semantics while moving interactive trailing controls outside the row activation', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'http://relay.example.test',
            icon: 'link',
            selected: false,
            accessibilityRole: 'radio',
            menuActions: [{
                id: 'remove',
                title: 'Remove',
                onPress: vi.fn(),
            }],
            onPress: vi.fn(),
        }));

        const row = screen.findByTestId('wizard-choice');
        expect(row).toBeTruthy();
        expect(row?.props.role).toBe('radio');
        expect(row?.props['aria-checked']).toBe(false);
        expect(row?.props.accessibilityState).toEqual({ checked: false });

        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        let ancestor: ReactTestInstance | null = overflowTrigger?.parent ?? null;
        while (ancestor) {
            expect(ancestor.type).not.toBe('Pressable');
            ancestor = ancestor.parent;
        }
    });

    it('keeps the plain row on the web button role when there is no interactive trailing content', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Cloud',
            subtitle: 'Hosted relay',
            icon: 'cloud',
            selected: true,
            onPress: vi.fn(),
        }));

        const row = screen.findByTestId('wizard-choice');
        expect(row).toBeTruthy();
        expect(row?.props.role).toBe('button');
    });

    it('avoids nested button semantics on web when rendering the overflow menu trigger', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'http://relay.example.test',
            icon: 'link',
            selected: false,
            menuActions: [{
                id: 'remove',
                title: 'Remove',
                onPress: vi.fn(),
            }],
            onPress: vi.fn(),
        }));

        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        expect(overflowTrigger).toBeTruthy();
        expect(overflowTrigger?.type).toBe('Pressable');
        expect(overflowTrigger?.props.accessibilityRole).toBe('button');
    });
});
