import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { renderScreen } from '@/dev/testkit';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let liveSecrets: SavedSecret[] = [];
const liveSecretListeners = new Set<() => void>();

function updateLiveSecrets(next: SavedSecret[]) {
    liveSecrets = next;
    for (const listener of liveSecretListeners) {
        listener();
    }
}

function resetLiveSecrets() {
    liveSecrets = [];
    liveSecretListeners.clear();
}

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
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
                textDestructive: '#f00',
                divider: '#ddd',
                surface: '#fff',
                success: '#0f0',
                accent: {
                    indigo: '#55f',
                    purple: '#95f',
                },
                button: {
                    primary: { background: '#00f', tint: '#fff' },
                    secondary: { tint: '#00f' },
                },
                input: {
                    background: '#fff',
                    placeholder: '#999',
                    text: '#000',
                },
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
                        select: <T,>(obj: { ios?: T; web?: T; default?: T }) => obj.ios ?? obj.web ?? obj.default,
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
    TextInput: React.forwardRef((props: Record<string, unknown>, ref) => React.createElement('TextInput', { ...props, ref })),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: ({
        children,
        isOpen,
        onOpenChange,
        title,
        saveDisabled,
        onSave,
    }: {
        children?: React.ReactNode;
        isOpen: boolean;
        onOpenChange: (next: boolean) => void;
        title: string;
        saveDisabled?: boolean;
        onSave?: () => void;
    }) => React.createElement(
        React.Fragment,
        null,
        React.createElement('Item', {
            title,
            onPress: () => onOpenChange(!isOpen),
        }),
        isOpen ? React.createElement(
            'View',
            null,
            children,
            React.createElement('Pressable', {
                accessibilityLabel: 'common.save',
                disabled: saveDisabled,
                onPress: onSave,
            }),
        ) : null,
    ),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: ({
        itemTrigger,
    }: {
        itemTrigger?: Readonly<{ title?: string; subtitle?: string }>;
    }) => React.createElement('Item', {
        title: itemTrigger?.title,
        subtitle: itemTrigger?.subtitle,
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSettingMutable: ((name: string) => {
            if (name !== 'secrets') {
                throw new Error(`Unexpected setting key in test: ${name}`);
            }

            const ReactModule = require('react') as typeof React;
            const [, forceUpdate] = ReactModule.useReducer((value: number) => value + 1, 0);

            ReactModule.useEffect(() => {
                const listener = () => forceUpdate();
                liveSecretListeners.add(listener);
                return () => {
                    liveSecretListeners.delete(listener);
                };
            }, []);

            return [liveSecrets, updateLiveSecrets] as const;
        }) as typeof import('@/sync/domains/state/storage').useSettingMutable,
    });
});

function findItems(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('Item');
}

function findGroups(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('ItemGroup');
}

function findItemByTitle(tree: renderer.ReactTestRenderer, title: string): ReactTestInstance | undefined {
    return findItems(tree).find((node) => node.props.title === title);
}

describe('value ref saved secrets live updates', () => {
    beforeEach(() => {
        resetLiveSecrets();
    });

    afterEach(() => {
        vi.clearAllMocks();
        resetLiveSecrets();
    });

    it('SavedSecretPickerModal reflects secrets added after the modal opens', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(SavedSecretPickerModal, {
                    onClose: vi.fn(),
                    selectedId: null,
                    onSelectId: vi.fn(),
                }))).tree;

        expect(tree.root.findAllByType('ItemList')).toHaveLength(1);
        expect(findGroups(tree).length).toBeGreaterThanOrEqual(2);
        expect(findItemByTitle(tree, 'secrets.emptyTitle')).toBeTruthy();
        expect(findItemByTitle(tree, 'qa_picker_live_modal')).toBeUndefined();

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_picker_live_modal',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(findItemByTitle(tree, 'secrets.emptyTitle')).toBeUndefined();
        expect(findItemByTitle(tree, 'qa_picker_live_modal')).toBeTruthy();
    });

    it('ValueRefEditorModal resolves saved-secret names from the live secrets store', async () => {
        const { ValueRefEditorModal } = await import('./ValueRefEditorModal');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ValueRefEditorModal, {
                    onClose: vi.fn(),
                    kind: 'header',
                    initialKey: 'Authorization',
                    initialValueRef: { t: 'savedSecret', secretId: 'secret-live' },
                    secrets: [],
                    onChangeSecrets: vi.fn(),
                    onSubmit: () => true,
                }))).tree;

        expect(tree.root.findAllByType('ItemList')).toHaveLength(1);
        expect(findGroups(tree).length).toBeGreaterThanOrEqual(2);
        expect(findItemByTitle(tree, 'settings.mcpServersValueSecretSelect')).toBeTruthy();
        expect(findItemByTitle(tree, 'qa_value_ref_live_secret')).toBeUndefined();

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_value_ref_live_secret',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(findItemByTitle(tree, 'settings.mcpServersValueSecretSelect')).toBeUndefined();
        expect(findItemByTitle(tree, 'qa_value_ref_live_secret')).toBeTruthy();
    });
});
