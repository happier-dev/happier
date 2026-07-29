import React from 'react';
import { act } from 'react-test-renderer';
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
            icon: 'cloud-outline',
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
            icon: 'link-outline',
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
            icon: 'link-outline',
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

        const row = screen.findByTestId('wizard-choice');
        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        expect(overflowTrigger).toBeTruthy();

        await act(async () => {
            overflowTrigger!.props.onPress?.({} as any);
            row?.props.onPress?.();
        });

        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('uses neutral foreground icons for selected rows', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'Hosted relay',
            icon: 'cloud-outline',
            selected: true,
            onPress: vi.fn(),
        }));

        const iconColors = screen.findAllByType('Ionicons' as any)
            .map((icon) => icon.props.color)
            .filter((color): color is string => typeof color === 'string');

        expect(iconColors).toContain('#111111');
        expect(iconColors).not.toContain('#007aff');
    });

    it('opts the row out of the web button role when it contains interactive trailing controls', async () => {
        // F-QAVISUAL-1: SelectableRow defaults webRole to 'button' (a real <button> on
        // react-native-web); with the overflow-menu trigger inside, that emits invalid
        // nested-button markup. Rows with interactive trailing content must use the
        // established `webRole="presentation"` escape hatch instead.
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'http://relay.example.test',
            icon: 'link-outline',
            selected: false,
            menuActions: [{
                id: 'remove',
                title: 'Remove',
                onPress: vi.fn(),
            }],
            onPress: vi.fn(),
        }));

        const row = screen.findByTestId('wizard-choice');
        expect(row).toBeTruthy();
        expect(row?.props.role).toBe('presentation');
    });

    it('keeps the plain row on the web button role when there is no interactive trailing content', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Cloud',
            subtitle: 'Hosted relay',
            icon: 'cloud-outline',
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
            icon: 'link-outline',
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
