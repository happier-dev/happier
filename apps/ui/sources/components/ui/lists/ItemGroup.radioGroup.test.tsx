import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: React.forwardRef((props: any, ref: React.ForwardedRef<unknown>) => (
                React.createElement('Pressable', { ...props, ref }, props.children)
            )),
        });
    },
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

type ProviderId = 'off' | 'hosted' | 'openai' | 'codex' | 'none';

let ItemGroupComponent: typeof import('./ItemGroup')['ItemGroup'];
let ItemComponent: typeof import('./Item')['Item'];

beforeAll(async () => {
    ({ ItemGroup: ItemGroupComponent } = await import('./ItemGroup'));
    ({ Item: ItemComponent } = await import('./Item'));
});

const PROVIDERS = [
    { id: 'off', label: 'Off', disabled: false },
    { id: 'hosted', label: 'Hosted voice', disabled: true },
    { id: 'openai', label: 'OpenAI', disabled: false },
    { id: 'codex', label: 'Codex', disabled: false },
] as const;

function RadioGroupHarness(props: Readonly<{
    initialSelected: ProviderId;
    onSelect?: (id: Exclude<ProviderId, 'none'>) => void;
}>) {
    const [selected, setSelected] = React.useState<ProviderId>(props.initialSelected);
    return (
        <ItemGroupComponent accessibilityRole="radiogroup" accessibilityLabel="Voice provider">
            {PROVIDERS.map((provider) => (
                <ItemComponent
                    key={provider.id}
                    testID={`provider:${provider.id}`}
                    title={provider.label}
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={selected === provider.id}
                    disabled={provider.disabled}
                    onPress={provider.disabled ? undefined : () => {
                        setSelected(provider.id);
                        props.onSelect?.(provider.id);
                    }}
                    showChevron={false}
                />
            ))}
        </ItemGroupComponent>
    );
}

function keyEvent(key: string) {
    return {
        key,
        nativeEvent: { key },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

describe('ItemGroup radio selection', () => {
    it('exposes one named radio group with checked, disabled, and roving-tab-stop semantics', async () => {
        const screen = await renderScreen(
            <RadioGroupHarness initialSelected="openai" />,
        );

        const group = screen.findAllByType('View' as never).find((node) => node.props.role === 'radiogroup');
        expect(group?.props.accessibilityLabel).toBe('Voice provider');
        expect(group?.props['aria-label']).toBe('Voice provider');

        const rows = PROVIDERS.map((provider) => screen.findByTestId(`provider:${provider.id}`)!);
        expect(rows.map((row) => row.props.role)).toEqual(['radio', 'radio', 'radio', 'radio']);
        expect(rows.map((row) => row.props['aria-checked'])).toEqual([false, false, true, false]);
        expect(rows.map((row) => row.props.tabIndex)).toEqual([-1, -1, 0, -1]);
        expect(rows[1]?.props.accessibilityState).toEqual({ checked: false, disabled: true });
        expect(rows[1]?.props['aria-disabled']).toBe(true);
    });

    it('preserves native screen-reader group, radio, checked, and disabled semantics', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'ios';
        try {
            const screen = await renderScreen(
                <RadioGroupHarness initialSelected="openai" />,
            );
            const group = screen.findAllByType('View' as never)
                .find((node) => node.props.accessibilityRole === 'radiogroup');
            expect(group?.props.accessibilityLabel).toBe('Voice provider');
            expect(group?.props.role).toBeUndefined();
            expect(screen.findByTestId('provider:openai')?.props.accessibilityRole).toBe('radio');
            expect(screen.findByTestId('provider:openai')?.props.accessibilityState).toEqual({ checked: true });
            expect(screen.findByTestId('provider:hosted')?.props.accessibilityState).toEqual({
                checked: false,
                disabled: true,
            });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('requires a non-empty accessible name when opting into radiogroup semantics', async () => {
        await expect(renderScreen(
            <ItemGroupComponent accessibilityRole="radiogroup" accessibilityLabel="   ">
                <ItemComponent
                    testID="unnamed-radio"
                    title="Unlabeled group option"
                    accessibilityRole="radio"
                    webRole="radio"
                    onPress={() => {}}
                />
            </ItemGroupComponent>,
        )).rejects.toThrow(/accessible name/i);
    });

    it('projects an omitted radio selection as Boolean unchecked state', async () => {
        const screen = await renderScreen(
            <ItemGroupComponent accessibilityRole="radiogroup" accessibilityLabel="Unselected provider">
                <ItemComponent
                    testID="unselected-radio"
                    title="Unselected"
                    accessibilityRole="radio"
                    webRole="radio"
                    onPress={() => {}}
                />
            </ItemGroupComponent>,
        );

        const row = screen.findByTestId('unselected-radio')!;
        expect(row.props.accessibilityState).toEqual({ checked: false });
        expect(row.props['aria-checked']).toBe(false);
    });

    it('selects and focuses enabled neighbors with every Arrow key plus Home and End', async () => {
        const onSelect = vi.fn();
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const screen = await renderScreen(
            <RadioGroupHarness initialSelected="openai" onSelect={onSelect} />,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('provider:')) return {};
                    const focus = vi.fn();
                    focusByTestId.set(testID, focus);
                    return { focus };
                },
            },
        );

        const pressKey = async (testID: string, key: string) => {
            const event = keyEvent(key);
            await act(async () => {
                screen.findByTestId(testID)?.props.onKeyDown?.(event);
            });
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopPropagation).toHaveBeenCalledOnce();
        };

        await pressKey('provider:openai', 'ArrowRight');
        expect(onSelect).toHaveBeenLastCalledWith('codex');
        expect(focusByTestId.get('provider:codex')).toHaveBeenCalledOnce();
        expect(screen.findByTestId('provider:codex')?.props.tabIndex).toBe(0);

        await pressKey('provider:codex', 'ArrowDown');
        expect(onSelect).toHaveBeenLastCalledWith('off');
        expect(focusByTestId.get('provider:off')).toHaveBeenCalledOnce();

        await pressKey('provider:off', 'ArrowLeft');
        expect(onSelect).toHaveBeenLastCalledWith('codex');

        await pressKey('provider:codex', 'ArrowUp');
        expect(onSelect).toHaveBeenLastCalledWith('openai');

        await pressKey('provider:openai', 'Home');
        expect(onSelect).toHaveBeenLastCalledWith('off');

        await pressKey('provider:off', 'End');
        expect(onSelect).toHaveBeenLastCalledWith('codex');

        expect(onSelect.mock.calls.map(([id]) => id)).toEqual([
            'codex',
            'off',
            'codex',
            'openai',
            'off',
            'codex',
        ]);
        expect(onSelect).not.toHaveBeenCalledWith('hosted');
    });

    it('follows visual Left and Right order in RTL layouts while skipping disabled rows', async () => {
        const { I18nManager } = await import('react-native');
        const previousIsRTL = I18nManager.isRTL;
        (I18nManager as { isRTL: boolean }).isRTL = true;
        try {
            const onSelect = vi.fn();
            const screen = await renderScreen(
                <RadioGroupHarness initialSelected="openai" onSelect={onSelect} />,
            );

            await act(async () => {
                screen.findByTestId('provider:openai')?.props.onKeyDown?.(keyEvent('ArrowRight'));
            });
            await act(async () => {
                screen.findByTestId('provider:off')?.props.onKeyDown?.(keyEvent('ArrowLeft'));
            });

            expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['off', 'openai']);
            expect(onSelect).not.toHaveBeenCalledWith('hosted');
        } finally {
            (I18nManager as { isRTL: boolean }).isRTL = previousIsRTL;
        }
    });

    it('uses the first enabled row as the sole tab stop when selection is absent or disabled', async () => {
        const noSelection = await renderScreen(<RadioGroupHarness initialSelected="none" />);
        const disabledSelection = await renderScreen(<RadioGroupHarness initialSelected="hosted" />);

        for (const screen of [noSelection, disabledSelection]) {
            expect(PROVIDERS.map((provider) => (
                screen.findByTestId(`provider:${provider.id}`)?.props.tabIndex
            ))).toEqual([0, -1, -1, -1]);
        }
    });

    it('skips loading radios and leaves an all-disabled group without a tab stop', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <ItemGroupComponent accessibilityRole="radiogroup" accessibilityLabel="Loading providers">
                <ItemComponent
                    testID="loading:first"
                    title="First"
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={true}
                    onPress={() => onSelect('first')}
                />
                <ItemComponent
                    testID="loading:pending"
                    title="Pending"
                    accessibilityRole="radio"
                    webRole="radio"
                    loading={true}
                    onPress={() => onSelect('pending')}
                />
                <ItemComponent
                    testID="loading:last"
                    title="Last"
                    accessibilityRole="radio"
                    webRole="radio"
                    onPress={() => onSelect('last')}
                />
            </ItemGroupComponent>,
        );

        await act(async () => {
            screen.findByTestId('loading:first')?.props.onKeyDown?.(keyEvent('ArrowRight'));
        });
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('last');

        const allDisabled = await renderScreen(
            <ItemGroupComponent accessibilityRole="radiogroup" accessibilityLabel="Unavailable providers">
                <ItemComponent
                    testID="disabled:first"
                    title="Disabled first"
                    accessibilityRole="radio"
                    webRole="radio"
                    disabled={true}
                    onPress={() => {}}
                />
                <ItemComponent
                    testID="disabled:second"
                    title="Disabled second"
                    accessibilityRole="radio"
                    webRole="radio"
                    loading={true}
                    onPress={() => {}}
                />
            </ItemGroupComponent>,
        );
        expect(['disabled:first', 'disabled:second'].map((testID) => (
            allDisabled.findByTestId(testID)?.props.tabIndex
        ))).toEqual([-1, -1]);
    });

    it('activates Space once and leaves Enter to the Pressable without moving to a neighbor', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <RadioGroupHarness initialSelected="openai" onSelect={onSelect} />,
        );
        const codex = screen.findByTestId('provider:codex')!;

        await act(async () => {
            codex.props.onKeyDown(keyEvent(' '));
        });
        expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['codex']);
        expect(screen.findByTestId('provider:codex')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('provider:off')?.props.tabIndex).toBe(-1);

        await act(async () => {
            screen.findByTestId('provider:off')?.props.onKeyDown(keyEvent('Enter'));
        });
        expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['codex']);

        await screen.pressByTestIdAsync('provider:off');
        expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['codex', 'off']);
        expect(onSelect).not.toHaveBeenCalledWith('openai');
        expect(onSelect).not.toHaveBeenCalledWith('hosted');

        const unrelatedKey = keyEvent('PageDown');
        await act(async () => {
            screen.findByTestId('provider:off')?.props.onKeyDown(unrelatedKey);
        });
        expect(unrelatedKey.preventDefault).not.toHaveBeenCalled();
        expect(unrelatedKey.stopPropagation).not.toHaveBeenCalled();
        expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['codex', 'off']);
    });

    it('does not add group or roving semantics to ordinary ItemGroup consumers', async () => {
        const screen = await renderScreen(
            <ItemGroupComponent title="Actions">
                <ItemComponent testID="action:first" title="First" onPress={() => {}} />
                <ItemComponent testID="action:second" title="Second" onPress={() => {}} />
            </ItemGroupComponent>,
        );

        expect(screen.findAllByType('View' as never).some((node) => node.props.role === 'radiogroup')).toBe(false);
        expect(screen.findByTestId('action:first')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('action:second')?.props.tabIndex).toBe(0);
    });
});
