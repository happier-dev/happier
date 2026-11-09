import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import type { EnvPreviewSecretsPolicy, PreviewEnvValue } from '@/sync/ops';
import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { installProfilesCommonModuleMocks } from '../profilesTestHelpers';
import { EnvironmentVariablesList } from './EnvironmentVariablesList';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

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

type EnvironmentVariablesHookResult = {
    variables: Record<string, string | null>;
    meta: Record<string, PreviewEnvValue>;
    policy: EnvPreviewSecretsPolicy | null;
    isPreviewEnvSupported: boolean;
    isLoading: boolean;
};

const useEnvironmentVariablesMock = vi.fn(
    (
        _machineId: string | null,
        _refs: string[],
        _options?: { extraEnv?: Record<string, string>; sensitiveKeys?: string[]; serverId?: string | null },
    ): EnvironmentVariablesHookResult => ({
        variables: {},
        meta: {},
        policy: null,
        isPreviewEnvSupported: false,
        isLoading: false,
    }),
);

vi.mock('@/hooks/server/useEnvironmentVariables', () => ({
    useEnvironmentVariables: (
        machineId: string | null,
        refs: string[],
        options?: { extraEnv?: Record<string, string>; sensitiveKeys?: string[] },
    ) => useEnvironmentVariablesMock(machineId, refs, options),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

type UseEnvironmentVariablesArgs = [
    string | null,
    string[],
    { extraEnv?: Record<string, string>; sensitiveKeys?: string[]; serverId?: string | null } | undefined,
];

async function renderList(params: {
    environmentVariables: Array<{ name: string; value: string; isSecret?: boolean }>;
    profileDocs?: ProfileDocumentation | null;
    serverId?: string | null;
    onChange?: ReturnType<typeof vi.fn<(next: Array<{ name: string; value: string; isSecret?: boolean }>) => void>>;
    allowSourceRequirements?: boolean;
}) {
    const onChange =
        params.onChange ??
        vi.fn<(next: Array<{ name: string; value: string; isSecret?: boolean }>) => void>();
    const screen = await renderScreen(
        React.createElement(ListPresentationProvider, { value: 'page', children: React.createElement(EnvironmentVariablesList, {
            environmentVariables: params.environmentVariables,
            machineId: 'machine-1',
            serverId: params.serverId,
            profileDocs: params.profileDocs ?? null,
            onChange,
            onAddVariable: ({ variable }) => onChange([...params.environmentVariables, variable]),
            sourceRequirementsByName: {},
            onUpdateSourceRequirement: () => {},
            getDefaultSecretNameForSourceVar: () => null,
            onPickDefaultSecretForSourceVar: () => {},
            allowSourceRequirements: params.allowSourceRequirements,
        }) }),
    );
    return { screen, onChange };
}

function getLastUseEnvironmentVariablesCall(): UseEnvironmentVariablesArgs {
    const call = useEnvironmentVariablesMock.mock.calls.at(-1);
    expect(call).toBeTruthy();
    return call as UseEnvironmentVariablesArgs;
}

describe('EnvironmentVariablesList', () => {
    beforeEach(() => {
        useEnvironmentVariablesMock.mockClear();
    });

    it('suppresses profile secret-requirement controls for slim launch profiles', async () => {
        const { screen } = await renderList({
            environmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
            allowSourceRequirements: false,
        });
        expect(screen.findByType(EnvironmentVariableCard).props.showSourceRequirements).toBe(false);
    });

    it('keeps an Administration-selected server context for environment previews', async () => {
        await renderList({
            environmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
            serverId: 'server-profile-b',
        });

        const [machineId, _keys, options] = getLastUseEnvironmentVariablesCall();
        expect(machineId).toBe('machine-1');
        expect(options?.serverId).toBe('server-profile-b');
    });

    it.each([{ environmentVariables: [] }, { environmentVariables: [{ name: 'SAFE_FLAG', value: '1' }] }])('opens the complete add editor from the visible action (variables: %j)', async ({ environmentVariables }) => {
        const { screen } = await renderList({ environmentVariables });
        await act(async () => screen.pressByTestId('profile-environment-add'));
        expect(screen.findAllByType(EnvironmentVariableCard)).toHaveLength(environmentVariables.length + 1);
        await act(async () => screen.changeTextByTestId('profile-environment-add-name', 'NEW_VARIABLE'));
        expect(screen.findAllByType(EnvironmentVariableCard).at(-1)?.props.variable.name).toBe('NEW_VARIABLE');
    });

    describe('inline add interaction', () => {
        it('adds a variable via the inline expander', async () => {
            const { screen, onChange } = await renderList({ environmentVariables: [] });

            const addExpander = screen.findByType(InlineAddExpander);
            expect(addExpander).toBeTruthy();

            await act(async () => {
                addExpander.props.onOpenChange(true);
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            const textInputs = screen.findAllByType('TextInput');
            const nameInput = textInputs[0];
            const valueInput = textInputs[1];
            expect(nameInput).toBeTruthy();
            expect(valueInput).toBeTruthy();

            await act(async () => {
                nameInput.props.onChangeText?.('FOO');
                valueInput.props.onChangeText?.('bar');
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            const saveButton = screen.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'profile-environment-add-save')[0]!;

            await act(async () => {
                saveButton.props.onPress?.();
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange.mock.calls[0]?.[0]).toEqual([{ name: 'FOO', value: 'bar' }]);
        });
    });

    describe('sensitive key propagation', () => {
        it('marks documented secret refs as sensitive keys for daemon preview', async () => {
            const profileDocs: ProfileDocumentation = {
                description: 'test',
                environmentVariables: [
                    {
                        name: 'MAGIC',
                        expectedValue: '***',
                        description: 'secret but name is not secret-like',
                        isSecret: true,
                    },
                ],
                shellConfigExample: '',
            };

            await renderList({
                environmentVariables: [
                    { name: 'FOO', value: '${MAGIC}' },
                    { name: 'BAR', value: '${HOME}' },
                ],
                profileDocs,
            });

            const [_machineId, keys, options] = getLastUseEnvironmentVariablesCall();
            expect(keys).toEqual(expect.arrayContaining(['FOO', 'BAR', 'MAGIC', 'HOME']));
            expect(options?.sensitiveKeys ?? []).toContain('MAGIC');
        });

        it('marks a documented-secret variable as secret even when it references another variable', async () => {
            const profileDocs: ProfileDocumentation = {
                description: 'test',
                environmentVariables: [
                    {
                        name: 'MAGIC',
                        expectedValue: '***',
                        description: 'secret',
                        isSecret: true,
                    },
                ],
                shellConfigExample: '',
            };

            const { screen } = await renderList({
                environmentVariables: [{ name: 'MAGIC', value: '${HOME}' }],
                profileDocs,
            });

            const [_machineId, keys, options] = getLastUseEnvironmentVariablesCall();
            expect(keys).toEqual(expect.arrayContaining(['MAGIC', 'HOME']));
            expect(options?.sensitiveKeys ?? []).toEqual(expect.arrayContaining(['MAGIC', 'HOME']));

            expect(screen.findAllByType(EnvironmentVariableCard)).toHaveLength(1);
            expect(screen.findByType(EnvironmentVariableCard).props.isSecret).toBe(true);
            expect(screen.findByType(EnvironmentVariableCard).props.expectedValue).toBe('***');
        });

        it('respects daemon-forced sensitivity in card props', async () => {
            useEnvironmentVariablesMock.mockReturnValueOnce({
                variables: {},
                meta: {
                    AUTH_MODE: {
                        value: null,
                        isSet: true,
                        isSensitive: true,
                        isForcedSensitive: true,
                        sensitivitySource: 'forced',
                        display: 'hidden',
                    },
                },
                policy: 'none',
                isPreviewEnvSupported: true,
                isLoading: false,
            });

            const { screen } = await renderList({
                environmentVariables: [{ name: 'AUTH_MODE', value: 'interactive', isSecret: false }],
            });

            expect(screen.findAllByType(EnvironmentVariableCard)).toHaveLength(1);
            expect(screen.findByType(EnvironmentVariableCard).props.isSecret).toBe(true);
            expect(screen.findByType(EnvironmentVariableCard).props.isForcedSensitive).toBe(true);
            expect(screen.findByType(EnvironmentVariableCard).props.secretOverride).toBe(false);
        });
    });
});
