import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import React from 'react';
import { renderScreen } from '@/dev/testkit';
import { installProfilesCommonModuleMocks } from '../profilesTestHelpers';
import { EnvironmentVariableCard, type EnvironmentVariableCardProps } from './EnvironmentVariableCard';
import { Switch } from '@/components/ui/forms/Switch';
import { EnvironmentVariablesList, type ProfileSecretPickerSelection } from './EnvironmentVariablesList';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installProfilesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            TextInput: 'TextInput',
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

// The daemon RPC is the system boundary; keep the list, card and preview hook real.
vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: true, response: { values: {}, policy: 'none' } })),
    machineBash: vi.fn(),
}));

type RenderedCard = Awaited<ReturnType<typeof renderScreen>>;

async function renderCard(params: {
    value: string;
    onUpdate: ReturnType<typeof vi.fn<(index: number, next: string) => void>>;
    overrides?: Partial<EnvironmentVariableCardProps>;
}): Promise<RenderedCard> {
    return renderScreen(
        React.createElement(EnvironmentVariableCard, {
            variable: { name: 'FOO', value: params.value },
            index: 0,
            machineId: 'machine-1',
            onUpdate: params.onUpdate,
            onDelete: () => {},
            onDuplicate: () => {},
            ...params.overrides,
        }),
    );
}

function findTextInputs(screen: RenderedCard) {
    return screen.findAllByType('TextInput');
}

function findUseMachineSwitch(screen: RenderedCard) {
    const switches = screen.findAllByType(Switch);
    return switches.find((node) => node.props.disabled !== true);
}

describe('EnvironmentVariableCard', () => {
    it('configures a saved-secret variable before adding it and cancels without changing the profile', async () => {
        const onChange = vi.fn();
        const onUpdateSourceRequirement = vi.fn();
        const onAddVariable = vi.fn();
        const onPickDefaultSecretForSourceVar = vi.fn((_name: string, selection?: ProfileSecretPickerSelection) => selection?.onSelect('saved-1'));
        const screen = await renderScreen(React.createElement(EnvironmentVariablesList, {
            environmentVariables: [], machineId: null, onChange,
            sourceRequirementsByName: {}, onUpdateSourceRequirement,
            getDefaultSecretNameForSourceVar: (_name: string, id?: string | null) => id === 'saved-1' ? 'Work credential' : null,
            onPickDefaultSecretForSourceVar, onAddVariable,
        }));
        await act(async () => screen.findByType(InlineAddExpander).props.onOpenChange(true));
        await act(async () => screen.changeTextByTestId('profile-environment-add-name', 'custom_credential'));
        // The same card used for existing variables must be reachable before Add/Save.
        expect(screen.findAllByType(EnvironmentVariableCard)).toHaveLength(1);
        expect(screen.findByType(EnvironmentVariableCard).props.variable.name).toBe('CUSTOM_CREDENTIAL');
        const vaultSwitch = () => screen.findAllByType(Switch).find(node => node.props.testID === 'profile-environment-add-vault')!;
        await act(async () => vaultSwitch().props.onValueChange(true));
        expect(findTextInputs(screen).map(input => input.props.value)).toEqual(['CUSTOM_CREDENTIAL']);
        await act(async () => screen.pressByTestId('profile-environment-add-secret'));
        expect(screen.findAllByType(EnvironmentVariableCard)[0].props.defaultSecretNameForSourceVar).toBe('Work credential');
        expect(onChange).not.toHaveBeenCalled();
        expect(onUpdateSourceRequirement).not.toHaveBeenCalled();
        await act(async () => screen.findByType(InlineAddExpander).props.onCancel());
        expect(onAddVariable).not.toHaveBeenCalled();
        await act(async () => screen.findByType(InlineAddExpander).props.onOpenChange(true));
        await act(async () => screen.changeTextByTestId('profile-environment-add-name', 'custom_credential'));
        expect(vaultSwitch().props.value).toBe(false);
        await act(async () => vaultSwitch().props.onValueChange(true));
        await act(async () => screen.pressByTestId('profile-environment-add-secret'));
        await act(async () => screen.findByType(InlineAddExpander).props.onSave());
        expect(onAddVariable).toHaveBeenCalledWith({
            variable: { name: 'CUSTOM_CREDENTIAL', value: '', isSecret: true },
            requirement: { name: 'CUSTOM_CREDENTIAL', required: true, useSecretVault: true, secretId: 'saved-1' },
        });
    });

    it.each([null, 'machine-1'])('keeps rapid edits through the real list and preview hook (machine: %s)', async (machineId) => {
        function Editor() {
            const [variables, setVariables] = React.useState([{ name: 'FOO', value: '' }]);
            return React.createElement(EnvironmentVariablesList, {
                environmentVariables: variables,
                machineId,
                onChange: setVariables,
                onAddVariable: ({ variable }) => setVariables(existing => [...existing, variable]),
                sourceRequirementsByName: {},
                onUpdateSourceRequirement: () => {},
                getDefaultSecretNameForSourceVar: () => null,
                onPickDefaultSecretForSourceVar: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(Editor));
        for (const value of ['a', 'ab', 'abc', 'abcd']) {
            await act(async () => { findTextInputs(screen)[0].props.onChangeText(value); });
        }
        expect(findTextInputs(screen)[0]?.props.value).toBe('abcd');
        expect(screen.findByType(EnvironmentVariablesList).props.environmentVariables).toEqual([{ name: 'FOO', value: 'abcd' }]);
        if (machineId) {
            const { machinePreviewEnv } = await import('@/sync/ops');
            expect(machinePreviewEnv).toHaveBeenLastCalledWith(machineId, {
                keys: ['FOO'], extraEnv: { FOO: 'abcd' }, sensitiveKeys: [],
            }, { serverId: undefined });
        }
    });

    it('publishes every rapid literal edit directly without waiting for effects', async () => {
        const onUpdate = vi.fn<(index: number, next: string) => void>();
        const screen = await renderCard({ value: '', onUpdate });
        const [input] = findTextInputs(screen);

        await act(async () => {
            input.props.onChangeText('a');
            input.props.onChangeText('ab');
            input.props.onChangeText('abc');
            input.props.onChangeText('');
            expect(onUpdate.mock.calls).toEqual([[0, 'a'], [0, 'ab'], [0, 'abc'], [0, '']]);
        });
        expect(findTextInputs(screen)[0]?.props.value).toBe('');
    });

    it('keeps machine mode and the fallback while clearing and retyping the source', async () => {
        const onUpdate = vi.fn<(index: number, next: string) => void>();
        const screen = await renderCard({ value: '${BAR:=baz}', onUpdate });
        const [, source] = findTextInputs(screen);

        await act(async () => { source.props.onChangeText(''); });
        expect(onUpdate).not.toHaveBeenCalled();
        expect(findUseMachineSwitch(screen)?.props.value).toBe(true);
        expect(findTextInputs(screen)[1]?.props.value).toBe('');

        await act(async () => { findTextInputs(screen)[1].props.onChangeText('other'); });
        expect(onUpdate.mock.calls).toEqual([[0, '${OTHER:=baz}']]);
    });

    it('waits for a source when enabling machine mode and writes through when disabling it', async () => {
        const onUpdate = vi.fn<(index: number, next: string) => void>();
        const screen = await renderCard({ value: 'literal', onUpdate });
        await act(async () => { findUseMachineSwitch(screen)?.props.onValueChange(true); });
        expect(onUpdate).not.toHaveBeenCalled();
        await act(async () => { findTextInputs(screen)[1].props.onChangeText('source'); });
        expect(onUpdate.mock.calls.at(-1)).toEqual([0, '${SOURCE:-literal}']);
        await act(async () => { findUseMachineSwitch(screen)?.props.onValueChange(false); });
        expect(findTextInputs(screen)[0]?.props.value).toBe('literal');
    });

    it.each(['literal', '${BAR:=fallback}'])('clears vault plaintext or fallback from %s', async (value) => {
        const onUpdate = vi.fn<(index: number, next: string) => void>();
        const screen = await renderCard({
            value,
            onUpdate,
            overrides: { sourceRequirement: { required: true, useSecretVault: true } },
        });
        expect(onUpdate.mock.calls).toEqual([[0, value.startsWith('${') ? '${BAR}' : '']]);
        expect(findTextInputs(screen).every((input) => input.props.value !== 'fallback')).toBe(true);
    });

    describe('remote-template state synchronization', () => {
        it('syncs remote-variable toggle state when variable value changes externally', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR:-baz}', onUpdate });

            const initialUseMachineSwitch = findUseMachineSwitch(screen);
            expect(initialUseMachineSwitch?.props.value).toBe(true);

            await act(async () => {
                screen.tree.update(
                    React.createElement(EnvironmentVariableCard, {
                        variable: { name: 'FOO', value: 'literal' },
                        index: 0,
                        machineId: 'machine-1',
                        onUpdate,
                        onDelete: () => {},
                        onDuplicate: () => {},
                    }),
                );
            });

            const updatedUseMachineSwitch = findUseMachineSwitch(screen);
            expect(updatedUseMachineSwitch?.props.value).toBe(false);
            expect(findTextInputs(screen)[0]?.props.value).toBe('literal');
            expect(onUpdate).not.toHaveBeenCalled();
        });
    });

    describe('fallback template transformation', () => {
        it('adds a fallback operator when user enters fallback for template without one', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR}', onUpdate });

            const [fallbackInput] = findTextInputs(screen);
            expect(fallbackInput).toBeTruthy();

            await act(async () => {
                fallbackInput?.props.onChangeText?.('baz');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR:-baz}']);
        });

        it('removes operator when user clears existing fallback', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR:=baz}', onUpdate });

            const [fallbackInput] = findTextInputs(screen);
            expect(fallbackInput).toBeTruthy();

            await act(async () => {
                fallbackInput?.props.onChangeText?.('');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR}']);
        });
    });
});
