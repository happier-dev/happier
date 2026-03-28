import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    changeTextTestInstance,
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { SecretsList } from './SecretsList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                surface: '#fff',
                button: { primary: { background: '#00f', tint: '#fff' }, secondary: { tint: '#00f' } },
                input: { background: '#fff', placeholder: '#999', text: '#000' },
                groupped: { sectionTitle: '#333' },
            },
        },
    });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                        OS: 'ios',
                                        select: <T,>(obj: { ios?: T; default?: T }) => obj.ios ?? obj.default,
                                    },
                                    AppState: {
                                        addEventListener: () => ({ remove: () => {} }),
                                    },
                                    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Pressable', props, props.children),
                                    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Text', props, props.children),
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                    TextInput: React.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {
                                        if (ref && typeof ref === 'object') {
                                            ref.current = { focus: () => {} };
                                        }
                                        return React.createElement('TextInput', props);
                                    }),
                                }
    );
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/lists/ItemGroup')>();
    return {
        ...actual,
        ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    };
});

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            prompt: vi.fn(),
            confirm: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

async function renderSecretsList(params?: {
    secrets?: SavedSecret[];
    allowAdd?: boolean;
    includeNoneRow?: boolean;
    defaultId?: string | null;
}) {
    const onChangeSecrets = vi.fn<(next: SavedSecret[]) => void>();
    const onAfterAddSelectId = vi.fn<(id: string) => void>();
    const onSelectId = vi.fn<(id: string) => void>();

    const screen = await renderScreen(
        React.createElement(SecretsList, {
            secrets: params?.secrets ?? [],
            onChangeSecrets,
            onAfterAddSelectId,
            onSelectId,
            defaultId: params?.defaultId,
            includeNoneRow: params?.includeNoneRow,
            allowAdd: params?.allowAdd,
        }),
    );

    return {
        screen,
        onChangeSecrets,
        onAfterAddSelectId,
        onSelectId,
    };
}

describe('SecretsList', () => {
    beforeEach(() => {
        vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
        vi.spyOn(Date, 'now').mockReturnValue(123456);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('adds a secret via the inline expander without modal prompts', async () => {
        const { screen, onChangeSecrets, onAfterAddSelectId } = await renderSecretsList();

        const addItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add');
        expect(addItem).toBeTruthy();

        await pressTestInstanceAsync(addItem, 'common.add row');

        const nameInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.nameExample',
        });
        const valueInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.valueExample',
        });
        expect(nameInput).toBeTruthy();
        expect(valueInput).toBeTruthy();

        act(() => {
            changeTextTestInstance(nameInput, 'My Key', 'secret name input');
            changeTextTestInstance(valueInput, 'sk-test', 'secret value input');
        });

        const saveButton = findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.save',
        });
        expect(saveButton).toBeTruthy();
        expect(saveButton?.props.disabled).toBe(false);

        await pressTestInstanceAsync(saveButton, 'common.save button');

        expect(onChangeSecrets).toHaveBeenCalledTimes(1);
        const nextSecrets = onChangeSecrets.mock.calls[0]?.[0] ?? [];
        expect(nextSecrets[0]).toMatchObject({
            id: 'uuid-1',
            name: 'My Key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'sk-test' },
            createdAt: 123456,
            updatedAt: 123456,
        });
        expect(onAfterAddSelectId).toHaveBeenCalledWith('uuid-1');
    });

    it('keeps save disabled until both name and value are provided', async () => {
        const { screen } = await renderSecretsList();

        const addItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add');
        expect(addItem).toBeTruthy();

        await pressTestInstanceAsync(addItem, 'common.add row');

        const nameInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.nameExample',
        });
        const valueInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.valueExample',
        });
        const saveButton = findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.save',
        });

        expect(saveButton?.props.disabled).toBe(true);

        act(() => {
            changeTextTestInstance(nameInput, 'ONLY_NAME', 'secret name input');
        });
        expect(findTestInstanceByTypeWithProps(screen, 'Pressable', { accessibilityLabel: 'common.save' })?.props.disabled).toBe(true);

        act(() => {
            changeTextTestInstance(valueInput, 'has-value', 'secret value input');
        });
        expect(findTestInstanceByTypeWithProps(screen, 'Pressable', { accessibilityLabel: 'common.save' })?.props.disabled).toBe(false);
    });

    it('does not expose add control when adding is disabled', async () => {
        const { screen } = await renderSecretsList({ allowAdd: false });
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add')).toBeUndefined();
    });

    it('moves default secret to the first rendered position', async () => {
        const secrets: SavedSecret[] = [
            {
                id: 'secret-a',
                name: 'Primary',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'a' },
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: 'secret-b',
                name: 'Secondary',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'b' },
                createdAt: 2,
                updatedAt: 2,
            },
        ];

        const { screen } = await renderSecretsList({ secrets, defaultId: 'secret-b', allowAdd: false });
        const textContent = screen.getTextContent();
        expect(textContent.indexOf('Secondary')).toBeGreaterThanOrEqual(0);
        expect(textContent.indexOf('Primary')).toBeGreaterThanOrEqual(0);
        expect(textContent.indexOf('Secondary')).toBeLessThan(textContent.indexOf('Primary'));
    });

    it('selects none row when include-none entry is pressed', async () => {
        const { screen, onSelectId } = await renderSecretsList({ includeNoneRow: true, allowAdd: false });
        const noneItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'secrets.noneTitle');
        expect(noneItem).toBeTruthy();

        await pressTestInstanceAsync(noneItem, 'secrets.none row');

        expect(onSelectId).toHaveBeenCalledWith('');
    });
});
