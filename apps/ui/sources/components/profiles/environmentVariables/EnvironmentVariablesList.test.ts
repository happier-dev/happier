import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import React from 'react';
import type { ProfileDocumentation } from '@/sync/profileUtils';
import { EnvironmentVariablesList } from './EnvironmentVariablesList';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
    },
}));

const useEnvironmentVariablesMock = vi.fn(
    (_machineId: string | null, _refs: string[], _options?: { extraEnv?: Record<string, string>; sensitiveKeys?: string[] }) => ({
        variables: {},
        meta: {},
        policy: null as null,
        isPreviewEnvSupported: false,
        isLoading: false,
    }),
);

vi.mock('@/hooks/useEnvironmentVariables', () => ({
    useEnvironmentVariables: (
        machineId: string | null,
        refs: string[],
        options?: { extraEnv?: Record<string, string>; sensitiveKeys?: string[] },
    ) => useEnvironmentVariablesMock(machineId, refs, options),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { sectionTitle: '#000' },
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                surface: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
            },
        },
    }),
    StyleSheet: {
        create: (factory: (theme: unknown) => unknown) =>
            factory({
                colors: {
                    groupped: { sectionTitle: '#000' },
                    input: { background: '#fff', text: '#000', placeholder: '#999' },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000' },
                    },
                    surface: '#fff',
                    shadow: { color: '#000', opacity: 0.1 },
                },
            }),
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('./EnvironmentVariableCard', () => ({
    EnvironmentVariableCard: (props: Record<string, unknown>) => React.createElement('EnvironmentVariableCard', props),
}));

type UseEnvironmentVariablesArgs = [
    string | null,
    string[],
    { extraEnv?: Record<string, string>; sensitiveKeys?: string[] } | undefined,
];

function renderList(params: {
    environmentVariables: Array<{ name: string; value: string; isSecret?: boolean }>;
    profileDocs?: ProfileDocumentation | null;
    onChange?: ReturnType<typeof vi.fn<(next: Array<{ name: string; value: string; isSecret?: boolean }>) => void>>;
}) {
    const onChange = params.onChange ?? vi.fn<(next: Array<{ name: string; value: string; isSecret?: boolean }>) => void>();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            React.createElement(EnvironmentVariablesList, {
                environmentVariables: params.environmentVariables,
                machineId: 'machine-1',
                profileDocs: params.profileDocs ?? null,
                onChange,
                sourceRequirementsByName: {},
                onUpdateSourceRequirement: () => {},
                getDefaultSecretNameForSourceVar: () => null,
                onPickDefaultSecretForSourceVar: () => {},
            }),
        );
    });
    return { tree: tree!, onChange };
}

function findItems(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('Item');
}

function findTextInputs(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('TextInput');
}

function findSaveButton(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    return tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === 'common.save');
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

    describe('inline add interaction', () => {
        it('adds a variable via the inline expander', () => {
            const { tree, onChange } = renderList({ environmentVariables: [] });

            const addItem = findItems(tree).find((node) => node.props.title === 'profiles.environmentVariables.addVariable');
            expect(addItem).toBeTruthy();

            act(() => {
                addItem?.props.onPress?.();
            });

            const [nameInput, valueInput] = findTextInputs(tree);
            expect(nameInput).toBeTruthy();
            expect(valueInput).toBeTruthy();

            act(() => {
                nameInput?.props.onChangeText?.('FOO');
                valueInput?.props.onChangeText?.('bar');
            });

            const saveButton = findSaveButton(tree);
            expect(saveButton).toBeTruthy();

            act(() => {
                saveButton?.props.onPress?.();
            });

            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange.mock.calls[0]?.[0]).toEqual([{ name: 'FOO', value: 'bar' }]);
        });
    });

    describe('sensitive key propagation', () => {
        it('marks documented secret refs as sensitive keys for daemon preview', () => {
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

            renderList({
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

        it('marks a documented-secret variable as secret even when it references another variable', () => {
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

            const { tree } = renderList({
                environmentVariables: [{ name: 'MAGIC', value: '${HOME}' }],
                profileDocs,
            });

            const [_machineId, keys, options] = getLastUseEnvironmentVariablesCall();
            expect(keys).toEqual(expect.arrayContaining(['MAGIC', 'HOME']));
            expect(options?.sensitiveKeys ?? []).toEqual(expect.arrayContaining(['MAGIC', 'HOME']));

            const cards = tree.root.findAllByType('EnvironmentVariableCard');
            expect(cards).toHaveLength(1);
            expect(cards[0]?.props.isSecret).toBe(true);
            expect(cards[0]?.props.expectedValue).toBe('***');
        });

        it('respects daemon-forced sensitivity in card props', () => {
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

            const { tree } = renderList({
                environmentVariables: [{ name: 'AUTH_MODE', value: 'interactive', isSecret: false }],
            });

            const cards = tree.root.findAllByType('EnvironmentVariableCard');
            expect(cards).toHaveLength(1);
            expect(cards[0]?.props.isSecret).toBe(true);
            expect(cards[0]?.props.isForcedSensitive).toBe(true);
            expect(cards[0]?.props.secretOverride).toBe(false);
        });
    });
});
