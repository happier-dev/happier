import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

import { renderWizardChoiceList } from './WizardChoiceList';

vi.mock('react-native', async () => {
    const { installReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return installReactNativeWebMock({ Platform: { OS: 'web' } })();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#007aff' },
                border: { default: '#dddddd', strong: '#111111' },
                surface: {
                    pressed: '#eeeeee',
                    pressedOverlay: 'rgba(17,17,17,0.05)',
                    elevated: '#ffffff',
                    inset: '#f5f5f5',
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
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

function keyEvent(key: string) {
    return {
        key,
        nativeEvent: { key },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

function RelayChoiceListHarness(): React.ReactElement {
    const [selectedId, setSelectedId] = React.useState('saved');

    return (
        <>
            {renderWizardChoiceList({
                accessibilityLabel: 'Choose a relay',
                items: [
                    {
                        itemKey: 'saved',
                        testID: 'relay:saved',
                        selected: selectedId === 'saved',
                        icon: 'link',
                        title: 'Saved relay',
                        subtitle: 'https://saved.example.test',
                        onPress: () => setSelectedId('saved'),
                        menuActions: [{
                            id: 'remove',
                            title: 'Remove',
                            onPress: () => undefined,
                        }],
                    },
                    {
                        itemKey: 'cloud',
                        testID: 'relay:cloud',
                        selected: selectedId === 'cloud',
                        icon: 'cloud',
                        title: 'Happier Cloud',
                        subtitle: 'Hosted relay',
                        onPress: () => setSelectedId('cloud'),
                    },
                ],
            })}
        </>
    );
}

describe('renderWizardChoiceList', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('projects relay choices as one named radio group with checked state and roving keyboard selection', async () => {
        const screen = await renderScreen(<RelayChoiceListHarness />);

        const group = screen.findAllByType('View' as never).find((node) => node.props.role === 'radiogroup');
        expect(group?.props['aria-label']).toBe('Choose a relay');

        expect(screen.findByTestId('relay:saved')?.props.role).toBe('radio');
        expect(screen.findByTestId('relay:saved')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('relay:saved')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('relay:cloud')?.props.role).toBe('radio');
        expect(screen.findByTestId('relay:cloud')?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('relay:cloud')?.props.tabIndex).toBe(-1);

        const event = keyEvent('ArrowDown');
        await act(async () => {
            screen.findByTestId('relay:saved')?.props.onKeyDown?.(event);
        });

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(screen.findByTestId('relay:saved')?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('relay:cloud')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('relay:cloud')?.props.tabIndex).toBe(0);

        const spaceEvent = keyEvent(' ');
        await act(async () => {
            screen.findByTestId('relay:saved')?.props.onKeyDown?.(spaceEvent);
        });

        expect(spaceEvent.preventDefault).toHaveBeenCalledOnce();
        expect(spaceEvent.stopPropagation).toHaveBeenCalledOnce();
        expect(screen.findByTestId('relay:saved')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('relay:saved')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('relay:cloud')?.props['aria-checked']).toBe(false);
    });
});
