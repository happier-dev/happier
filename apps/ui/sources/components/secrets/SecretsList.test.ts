import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { SavedSecret } from '@/sync/domains/settings/settings';
import { SecretsList } from './SecretsList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: { create: <T,>(factory: T) => factory },
}));

vi.mock('react-native', () => {
    const ReactModule = require('react') as typeof React;

    const Pressable = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        ReactModule.createElement('Pressable', props, props.children);
    const Text = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        ReactModule.createElement('Text', props, props.children);
    const View = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        ReactModule.createElement('View', props, props.children);

    const TextInput = ReactModule.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {
        if (ref && typeof ref === 'object') {
            ref.current = { focus: () => {} };
        }
        return ReactModule.createElement('TextInput', props);
    });

    return {
        Platform: {
            OS: 'ios',
            select: <T,>(obj: { ios?: T; default?: T }) => obj.ios ?? obj.default,
        },
        AppState: { addEventListener: () => ({ remove: () => {} }) },
        Pressable,
        Text,
        View,
        TextInput,
    };
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() },
}));

function renderSecretsList(params?: {
    secrets?: SavedSecret[];
    allowAdd?: boolean;
    includeNoneRow?: boolean;
    defaultId?: string | null;
}) {
    const onChangeSecrets = vi.fn<(next: SavedSecret[]) => void>();
    const onAfterAddSelectId = vi.fn<(id: string) => void>();
    const onSelectId = vi.fn<(id: string) => void>();

    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
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
    });

    return { tree: tree!, onChangeSecrets, onAfterAddSelectId, onSelectId };
}

function findItems(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('Item');
}

function findItemByTitle(tree: renderer.ReactTestRenderer, title: string): ReactTestInstance | undefined {
    return findItems(tree).find((node) => node.props.title === title);
}

function findTextInputs(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('TextInput');
}

function findSaveButton(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    return tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === 'common.save');
}

function getFirstSecretTitles(tree: renderer.ReactTestRenderer): string[] {
    return findItems(tree)
        .map((node) => node.props.title)
        .filter((title): title is string => typeof title === 'string' && title !== 'common.add');
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

    it('adds a secret via the inline expander without modal prompts', () => {
        const { tree, onChangeSecrets, onAfterAddSelectId } = renderSecretsList();

        const addItem = findItemByTitle(tree, 'common.add');
        expect(addItem).toBeTruthy();

        act(() => {
            addItem?.props.onPress?.();
        });

        const [nameInput, valueInput] = findTextInputs(tree);
        expect(nameInput).toBeTruthy();
        expect(valueInput).toBeTruthy();

        act(() => {
            nameInput?.props.onChangeText?.('My Key');
            valueInput?.props.onChangeText?.('sk-test');
        });

        const saveButton = findSaveButton(tree);
        expect(saveButton).toBeTruthy();
        expect(saveButton?.props.disabled).toBe(false);

        act(() => {
            saveButton?.props.onPress?.();
        });

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

    it('keeps save disabled until both name and value are provided', () => {
        const { tree } = renderSecretsList();

        const addItem = findItemByTitle(tree, 'common.add');
        expect(addItem).toBeTruthy();

        act(() => {
            addItem?.props.onPress?.();
        });

        const [nameInput, valueInput] = findTextInputs(tree);
        const saveButton = findSaveButton(tree);

        expect(saveButton?.props.disabled).toBe(true);

        act(() => {
            nameInput?.props.onChangeText?.('ONLY_NAME');
        });
        expect(findSaveButton(tree)?.props.disabled).toBe(true);

        act(() => {
            valueInput?.props.onChangeText?.('has-value');
        });
        expect(findSaveButton(tree)?.props.disabled).toBe(false);
    });

    it('does not expose add control when adding is disabled', () => {
        const { tree } = renderSecretsList({ allowAdd: false });
        expect(findItemByTitle(tree, 'common.add')).toBeUndefined();
    });

    it('moves default secret to the first rendered position', () => {
        const secrets: SavedSecret[] = [
            {
                id: 'secret-a',
                name: 'A',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'a' },
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: 'secret-b',
                name: 'B',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'b' },
                createdAt: 2,
                updatedAt: 2,
            },
        ];

        const { tree } = renderSecretsList({ secrets, defaultId: 'secret-b', allowAdd: false });
        const titles = getFirstSecretTitles(tree);
        expect(titles[0]).toBe('B');
    });

    it('selects none row when include-none entry is pressed', () => {
        const { tree, onSelectId } = renderSecretsList({ includeNoneRow: true, allowAdd: false });
        const noneItem = findItemByTitle(tree, 'secrets.noneTitle');
        expect(noneItem).toBeTruthy();

        act(() => {
            noneItem?.props.onPress?.();
        });

        expect(onSelectId).toHaveBeenCalledWith('');
    });
});
